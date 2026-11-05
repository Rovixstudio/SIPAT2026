-- SIPAT CHALLENGE | Execute no SQL Editor do Supabase.
-- IMPORTANTE: nunca coloque a chave service_role no HTML/JS.
create extension if not exists pgcrypto;

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  access_code_hash text not null unique,
  name text not null,
  sector text not null,
  avatar text not null default '🦊',
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- Configure a data real de início da SIPAT (dia 1).
create table if not exists public.sipat_settings (
  singleton boolean primary key default true check (singleton),
  event_start_date date not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  day smallint not null check(day between 1 and 5),
  kind text not null check(kind in ('official','bonus')),
  prompt text not null,
  options jsonb not null check(jsonb_typeof(options)='array' and jsonb_array_length(options) between 2 and 6),
  correct_index smallint not null check(correct_index >= 0),
  points integer not null default 100 check(points between 1 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id),
  question_id uuid not null references public.questions(id),
  selected_index smallint not null,
  correct boolean not null,
  points integer not null default 0,
  created_at timestamptz not null default now(),
  unique(participant_id, question_id)
);

create index if not exists attempts_participant_idx on public.attempts(participant_id);
create index if not exists questions_kind_day_idx on public.questions(kind,day) where active=true;

alter table public.participants enable row level security;
alter table public.admins enable row level security;
alter table public.sipat_settings enable row level security;
alter table public.questions enable row level security;
alter table public.attempts enable row level security;

-- Acesso direto a tabelas só para administradores autenticados.
create or replace function public.is_sipat_admin()
returns boolean language sql stable security definer
set search_path=public
as $$ select exists(select 1 from public.admins where user_id=auth.uid()) $$;

create policy "admins read participants" on public.participants for select to authenticated using (public.is_sipat_admin());
create policy "admins manage participants" on public.participants for all to authenticated using (public.is_sipat_admin()) with check (public.is_sipat_admin());
create policy "admins read admins" on public.admins for select to authenticated using (public.is_sipat_admin());
create policy "admins manage settings" on public.sipat_settings for all to authenticated using (public.is_sipat_admin()) with check (public.is_sipat_admin());
create policy "admins read questions" on public.questions for select to authenticated using (public.is_sipat_admin());
create policy "admins manage questions" on public.questions for all to authenticated using (public.is_sipat_admin()) with check (public.is_sipat_admin());
create policy "admins read attempts" on public.attempts for select to authenticated using (public.is_sipat_admin());

-- Não expor tabelas diretamente ao público.
revoke all on public.participants, public.admins, public.sipat_settings, public.questions, public.attempts from anon, authenticated;
grant select, insert, update, delete on public.participants, public.questions, public.sipat_settings to authenticated;
grant select on public.admins, public.attempts to authenticated;

-- Funções públicas usam o código individual como credencial.
-- Os hashes ficam no banco; o código original não é armazenado.
create or replace function public.participant_login(p_access_code text)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare p public.participants;
begin
  select * into p from public.participants
  where access_code_hash=encode(digest(upper(trim(p_access_code)),'sha256'),'hex') and active=true;
  if not found then raise exception 'Código inválido ou participante inativo'; end if;
  return jsonb_build_object('id',p.id,'name',p.name,'sector',p.sector,'avatar',p.avatar);
end $$;

create or replace function public.participant_set_avatar(p_access_code text,p_avatar text)
returns boolean language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid;
begin
  select id into pid from public.participants
  where access_code_hash=encode(digest(upper(trim(p_access_code)),'sha256'),'hex') and active=true;
  if pid is null then raise exception 'Código inválido'; end if;
  if length(p_avatar)>12 then raise exception 'Avatar inválido'; end if;
  update public.participants set avatar=p_avatar where id=pid;
  return true;
end $$;

create or replace function public.participant_next_question(p_access_code text,p_kind text)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid; q public.questions; event_start date; event_day integer;
begin
  if p_kind not in ('official','bonus') then raise exception 'Tipo inválido'; end if;
  select id into pid from public.participants
  where access_code_hash=encode(digest(upper(trim(p_access_code)),'sha256'),'hex') and active=true;
  if pid is null then raise exception 'Código inválido'; end if;
  if p_kind='official' then
    select event_start_date into event_start from public.sipat_settings where singleton=true;
    if event_start is null then raise exception 'A organização ainda não configurou a data de início da SIPAT'; end if;
    event_day := (current_date - event_start) + 1;
    if event_day < 1 or event_day > 5 then return jsonb_build_object('status','complete'); end if;
    select * into q from public.questions
    where active=true and kind='official' and day=event_day
      and not exists(select 1 from public.attempts a where a.participant_id=pid and a.question_id=questions.id)
    order by created_at limit 1;
  else
    select * into q from public.questions
    where active=true and kind='bonus'
      and not exists(select 1 from public.attempts a where a.participant_id=pid and a.question_id=questions.id)
    order by random() limit 1;
  end if;
  if q.id is null then return jsonb_build_object('status','complete'); end if;
  return jsonb_build_object('id',q.id,'day',q.day,'kind',q.kind,'prompt',q.prompt,'options',q.options,'points',q.points);
end $$;

create or replace function public.participant_submit_answer(p_access_code text,p_question_id uuid,p_selected_index smallint)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid; q public.questions; is_correct boolean; earned integer;
begin
  select id into pid from public.participants
  where access_code_hash=encode(digest(upper(trim(p_access_code)),'sha256'),'hex') and active=true;
  if pid is null then raise exception 'Código inválido'; end if;
  select * into q from public.questions where id=p_question_id and active=true;
  if not found then raise exception 'Pergunta indisponível'; end if;
  if q.kind='official' and not exists (
    select 1 from public.sipat_settings s
    where s.singleton=true and (current_date-s.event_start_date)+1=q.day
  ) then raise exception 'Este desafio oficial não está aberto hoje'; end if;
  if p_selected_index<0 or p_selected_index>=jsonb_array_length(q.options) then raise exception 'Alternativa inválida'; end if;
  is_correct := p_selected_index=q.correct_index;
  earned := case when is_correct then q.points else 0 end;
  insert into public.attempts(participant_id,question_id,selected_index,correct,points)
  values(pid,q.id,p_selected_index,is_correct,earned);
  return jsonb_build_object('correct',is_correct,'points',earned);
exception when unique_violation then
  raise exception 'Esta pergunta já foi respondida por este participante';
end $$;

create or replace function public.participant_my_stats(p_access_code text)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid; total integer; qty integer; pos bigint;
begin
  select id into pid from public.participants
  where access_code_hash=encode(digest(upper(trim(p_access_code)),'sha256'),'hex') and active=true;
  if pid is null then raise exception 'Código inválido'; end if;
  select coalesce(sum(points),0),count(*) into total,qty from public.attempts where participant_id=pid;
  select count(*)+1 into pos from (
    select participant_id,sum(points) pts from public.attempts group by participant_id
  ) s where s.pts>total;
  return jsonb_build_object('points',total,'answers',qty,'rank',pos);
end $$;

create or replace function public.public_leaderboard(p_limit integer default 100)
returns table(name text,sector text,avatar text,points bigint)
language sql stable security definer set search_path=public
as $$
 select p.name,p.sector,p.avatar,coalesce(sum(a.points),0)::bigint
 from public.participants p left join public.attempts a on a.participant_id=p.id
 where p.active=true group by p.id order by 4 desc,p.name limit least(greatest(p_limit,1),100)
$$;

create or replace function public.admin_export_leaderboard()
returns table(name text,sector text,points bigint)
language plpgsql security definer set search_path=public
as $$
begin
 if not public.is_sipat_admin() then raise exception 'Acesso restrito'; end if;
 return query select p.name,p.sector,coalesce(sum(a.points),0)::bigint
 from public.participants p left join public.attempts a on a.participant_id=p.id
 group by p.id order by 3 desc,p.name;
end $$;

create or replace view public.admin_attempts_view with (security_invoker=true) as
select p.name as participant_name,q.day,q.kind,a.correct,a.points,a.created_at
from public.attempts a join public.participants p on p.id=a.participant_id
join public.questions q on q.id=a.question_id;

grant execute on function public.participant_login(text) to anon,authenticated;
grant execute on function public.participant_set_avatar(text,text) to anon,authenticated;
grant execute on function public.participant_next_question(text,text) to anon,authenticated;
grant execute on function public.participant_submit_answer(text,uuid,smallint) to anon,authenticated;
grant execute on function public.participant_my_stats(text) to anon,authenticated;
grant execute on function public.public_leaderboard(integer) to anon,authenticated;
grant execute on function public.admin_export_leaderboard() to authenticated;
grant select on public.admin_attempts_view to authenticated;

-- Perguntas demonstrativas. Troque ou amplie o banco antes da SIPAT.
insert into public.questions(day,kind,prompt,options,correct_index,points) values
(1,'official','Qual é a principal finalidade do EPI?','["Substituir treinamentos","Proteger contra riscos ocupacionais","Aumentar a velocidade","Eliminar todos os riscos"]',1,100),
(2,'official','Qual atitude favorece a ergonomia?','["Ajustar o posto de trabalho","Ignorar desconfortos","Evitar pausas","Trabalhar sempre na mesma posição"]',0,100),
(3,'official','Ao identificar uma condição insegura, o que fazer?','["Ignorar","Comunicar e seguir o procedimento","Esperar um acidente","Improvisar uma solução sem autorização"]',1,100),
(4,'official','Qual atitude ajuda o meio ambiente?','["Desperdiçar água","Misturar resíduos","Separar e descartar corretamente","Deixar luzes ligadas"]',2,100),
(5,'official','A prevenção de acidentes é responsabilidade de quem?','["Somente do técnico","Somente da liderança","Todos os envolvidos","Somente da direção"]',2,100),
(1,'bonus','Antes de iniciar uma atividade, é importante:','["Avaliar os riscos e seguir o procedimento","Correr para terminar","Usar qualquer ferramenta disponível","Pular orientações"]',0,30),
(1,'bonus','Uma rota de fuga deve permanecer:','["Trancada","Desobstruída e sinalizada","Usada como depósito","Sem iluminação"]',1,30),
(2,'bonus','Hidratação adequada durante o trabalho ajuda a:','["Substituir alimentação","Manter o bem-estar e funções do organismo","Eliminar pausas","Dispensar avaliação médica"]',1,30),
(2,'bonus','Ao sentir desconforto durante uma tarefa, o correto é:','["Esconder","Comunicar e buscar orientação","Aumentar o ritmo","Ignorar sempre"]',1,30),
(3,'bonus','Uma ferramenta danificada deve ser:','["Usada com cuidado","Retirada de uso e comunicada","Emprestada","Guardada sem avisar"]',1,30),
(3,'bonus','Sinalização de segurança serve para:','["Decorar o ambiente","Alertar e orientar sobre riscos","Substituir treinamento","Marcar horários"]',1,30),
(4,'bonus','A coleta seletiva contribui para:','["Aumentar desperdício","Facilitar reaproveitamento e reciclagem","Misturar materiais","Eliminar toda geração de resíduos"]',1,30),
(4,'bonus','Para economizar energia, podemos:','["Deixar aparelhos ligados","Desligar equipamentos sem uso quando seguro","Bloquear ventilação","Retirar sinalizações"]',1,30),
(5,'bonus','DDS significa, em geral:','["Diálogo Diário de Segurança","Documento de Dados de Saúde","Diretriz de Descarte Sustentável","Departamento de Serviços"]',0,30),
(5,'bonus','Em uma emergência, deve-se:','["Entrar em pânico","Seguir o plano de emergência e orientações","Usar elevador sempre","Voltar para buscar objetos"]',1,30)
on conflict do nothing;
