-- SIPAT CHALLENGE — MIGRAÇÃO ADITIVA DE SALAS E ENTRADA POR QR CODE
-- Execute no SQL Editor do projeto kffdbfmawbdewnlzuqdm.
-- Pressuposto: o esquema-base já existe (participants, admins, questions, attempts,
-- sipat_settings, is_sipat_admin(), e RPCs atuais). Este script NÃO apaga dados.
-- Não coloque service_role no frontend. As funções SECURITY DEFINER validam permissões.

begin;
create extension if not exists pgcrypto;

-- 1) Nova tabela de salas.
create table if not exists public.sipat_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  day smallint not null check (day between 1 and 5),
  active boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
-- Se uma sala/código for reutilizada em outro dia, criamos um novo registro.
-- Assim, participantes antigos continuam ligados ao dia original.
alter table public.sipat_rooms drop constraint if exists sipat_rooms_code_key;
create unique index if not exists sipat_rooms_one_active_idx
  on public.sipat_rooms ((active)) where active = true;
create index if not exists sipat_rooms_code_active_idx
  on public.sipat_rooms (code) where active = true;

-- 2) Colunas compatíveis com participantes já existentes.
alter table public.participants add column if not exists room_id uuid;
alter table public.participants add column if not exists session_token_hash text;
alter table public.participants add column if not exists last_seen_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'participants_room_id_fkey') then
    alter table public.participants add constraint participants_room_id_fkey
      foreign key (room_id) references public.sipat_rooms(id) on delete set null;
  end if;
end $$;
create unique index if not exists participants_session_token_hash_uidx
  on public.participants(session_token_hash) where session_token_hash is not null;
create index if not exists participants_room_id_idx on public.participants(room_id);

-- 3) RLS: salas somente administradores podem ler/modificar diretamente.
alter table public.sipat_rooms enable row level security;
drop policy if exists "sipat rooms admin access" on public.sipat_rooms;
create policy "sipat rooms admin access" on public.sipat_rooms
  for all to authenticated using (public.is_sipat_admin()) with check (public.is_sipat_admin());
revoke all on public.sipat_rooms from anon, authenticated;
grant select, insert, update, delete on public.sipat_rooms to authenticated;

-- 4) Entrada pública por QR Code. O token é criado no servidor, devolvido uma única
-- vez ao navegador e armazenado apenas como hash no banco.
create or replace function public.participant_room_info(p_room_code text)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions
as $$
declare r public.sipat_rooms;
begin
  select * into r from public.sipat_rooms where code = trim(p_room_code) and active = true;
  if not found then return jsonb_build_object('active', false); end if;
  return jsonb_build_object('active', true, 'code', r.code, 'day', r.day);
end $$;

create or replace function public.participant_join_room(
  p_room_code text, p_name text, p_sector text, p_avatar text default '👷'
) returns jsonb language plpgsql security definer
set search_path = public, extensions
as $$
declare r public.sipat_rooms; new_token text; new_participant public.participants;
begin
  if length(trim(coalesce(p_name,''))) < 2 or length(trim(p_name)) > 80 then
    raise exception 'Informe um nome entre 2 e 80 caracteres';
  end if;
  if length(trim(coalesce(p_sector,''))) < 2 or length(trim(p_sector)) > 80 then
    raise exception 'Informe um setor entre 2 e 80 caracteres';
  end if;
  if length(coalesce(p_avatar,'')) > 16 then raise exception 'Avatar inválido'; end if;
  select * into r from public.sipat_rooms where code = trim(p_room_code) and active = true for share;
  if not found then raise exception 'Sala inexistente ou inativa'; end if;
  new_token := encode(gen_random_bytes(32), 'hex');
  insert into public.participants(access_code_hash, session_token_hash, name, sector, avatar, room_id, active)
  values (
    encode(digest(upper(new_token), 'sha256'), 'hex'),
    encode(digest(new_token, 'sha256'), 'hex'),
    trim(p_name), trim(p_sector), coalesce(nullif(p_avatar,''),'👷'), r.id, true
  ) returning * into new_participant;
  return jsonb_build_object(
    'access_token', new_token,
    'participant', jsonb_build_object('id',new_participant.id,'name',new_participant.name,
      'sector',new_participant.sector,'avatar',new_participant.avatar,'room_code',r.code,'day',r.day)
  );
end $$;

-- Sessão interna: o participante não precisa criar conta nem informar senha.
create or replace function public.participant_session_info(p_access_token text)
returns jsonb language plpgsql security definer
set search_path = public, extensions
as $$
declare p public.participants; r public.sipat_rooms;
begin
  select * into p from public.participants
  where session_token_hash = encode(digest(p_access_token, 'sha256'), 'hex') and active = true;
  if not found then raise exception 'Sessão inválida. Entre novamente pelo QR Code.'; end if;
  update public.participants set last_seen_at = now() where id = p.id;
  select * into r from public.sipat_rooms where id = p.room_id;
  return jsonb_build_object('id',p.id,'name',p.name,'sector',p.sector,'avatar',p.avatar,
    'room_code',r.code,'day',r.day);
end $$;

-- 5) Helpers: suportam tokens novos e códigos legados existentes.
create or replace function public.sipat_resolve_participant(p_credential text)
returns uuid language plpgsql stable security definer
set search_path = public, extensions
as $$
declare pid uuid;
begin
  if p_credential is null or length(p_credential) < 8 then raise exception 'Credencial inválida'; end if;
  select id into pid from public.participants
   where active = true and session_token_hash = encode(digest(p_credential,'sha256'),'hex') limit 1;
  if pid is null then
    -- Compatibilidade com códigos de acesso já distribuídos antes desta migração.
    select id into pid from public.participants
     where active = true and access_code_hash = encode(digest(upper(trim(p_credential)),'sha256'),'hex') limit 1;
  end if;
  if pid is null then raise exception 'Participante não encontrado ou inativo'; end if;
  return pid;
end $$;

create or replace function public.participant_set_avatar(p_access_code text, p_avatar text)
returns boolean language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid;
begin
  if length(coalesce(p_avatar,'')) > 16 then raise exception 'Avatar inválido'; end if;
  pid := public.sipat_resolve_participant(p_access_code);
  update public.participants set avatar=p_avatar, last_seen_at=now() where id=pid;
  return true;
end $$;

-- 6) Perguntas oficiais e bônus sempre limitadas ao dia associado à sala.
create or replace function public.participant_next_question(p_access_code text, p_kind text)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid; p public.participants; r public.sipat_rooms; q public.questions; event_start date; event_day integer;
begin
  if p_kind not in ('official','bonus') then raise exception 'Tipo inválido'; end if;
  pid := public.sipat_resolve_participant(p_access_code);
  select * into p from public.participants where id=pid;
  if p.room_id is not null then
    select * into r from public.sipat_rooms where id=p.room_id;
    if not found then raise exception 'Sala vinculada não encontrada'; end if;
    event_day := r.day;
  else
    -- Participantes antigos sem sala continuam usando a configuração de data anterior.
    select event_start_date into event_start from public.sipat_settings where singleton=true;
    if event_start is null then raise exception 'Participante sem sala. Entre pelo QR Code ativo.'; end if;
    event_day := (current_date-event_start)+1;
  end if;
  if event_day < 1 or event_day > 5 then return jsonb_build_object('status','complete'); end if;
  select * into q from public.questions
   where active=true and kind=p_kind and day=event_day
     and not exists(select 1 from public.attempts a where a.participant_id=pid and a.question_id=questions.id)
   order by case when p_kind='official' then created_at end asc, random()
   limit 1;
  if q.id is null then return jsonb_build_object('status','complete'); end if;
  return jsonb_build_object('id',q.id,'day',q.day,'kind',q.kind,'prompt',q.prompt,'options',q.options,'points',q.points);
end $$;

-- 7) A pontuação é calculada e gravada exclusivamente no servidor.
create or replace function public.participant_submit_answer(
  p_access_code text, p_question_id uuid, p_selected_index smallint
) returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid; p public.participants; r public.sipat_rooms; q public.questions; event_day integer; is_correct boolean; earned integer;
begin
  pid := public.sipat_resolve_participant(p_access_code);
  select * into p from public.participants where id=pid;
  if p.room_id is not null then
    select * into r from public.sipat_rooms where id=p.room_id;
    if not found then raise exception 'Sala vinculada não encontrada'; end if;
    event_day := r.day;
  else
    select (current_date-event_start_date)+1 into event_day from public.sipat_settings where singleton=true;
  end if;
  select * into q from public.questions where id=p_question_id and active=true;
  if not found then raise exception 'Pergunta indisponível'; end if;
  if q.day <> event_day then raise exception 'Esta pergunta não pertence ao dia da sua sala'; end if;
  if p_selected_index is null or p_selected_index < 0 or p_selected_index >= jsonb_array_length(q.options) then raise exception 'Alternativa inválida'; end if;
  is_correct := p_selected_index=q.correct_index;
  earned := case when is_correct then q.points else 0 end;
  insert into public.attempts(participant_id,question_id,selected_index,correct,points)
  values(pid,q.id,p_selected_index,is_correct,earned);
  update public.participants set last_seen_at=now() where id=pid;
  return jsonb_build_object('correct',is_correct,'points',earned);
exception when unique_violation then
  raise exception 'Esta pergunta já foi respondida por este participante';
end $$;

create or replace function public.participant_my_stats(p_access_code text)
returns jsonb language plpgsql security definer set search_path=public,extensions
as $$
declare pid uuid; total integer; qty integer; pos bigint;
begin
  pid := public.sipat_resolve_participant(p_access_code);
  select coalesce(sum(points),0),count(*) into total,qty from public.attempts where participant_id=pid;
  select count(*)+1 into pos from (select participant_id,sum(points) pts from public.attempts group by participant_id) s where s.pts>total;
  return jsonb_build_object('points',total,'answers',qty,'rank',pos);
end $$;

-- 8) RPC de ativação: só administrador pode criar/ativar; desativa a sala anterior.
create or replace function public.admin_create_activate_room(p_code text, p_day smallint)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare r public.sipat_rooms;
begin
  if not public.is_sipat_admin() then raise exception 'Acesso restrito a administradores'; end if;
  if p_code is null or p_code !~ '^[A-Za-z0-9_-]{2,30}$' then raise exception 'Código de sala inválido'; end if;
  if p_day not between 1 and 5 then raise exception 'Dia deve estar entre 1 e 5'; end if;
  perform pg_advisory_xact_lock(hashtext('sipat_active_room'));
  update public.sipat_rooms set active=false where active=true;
  insert into public.sipat_rooms(code,day,active,created_by,activated_at)
  values(trim(p_code),p_day,true,auth.uid(),now())
  returning * into r;
  return jsonb_build_object('id',r.id,'code',r.code,'day',r.day,'active',r.active,'activated_at',r.activated_at);
end $$;

-- 9) Ranking público: avatar incluído e pontuação sempre agregada de attempts.
create or replace function public.public_leaderboard(p_limit integer default 650)
returns table(name text,sector text,avatar text,points bigint)
language sql stable security definer set search_path=public
as $$
 select p.name,p.sector,p.avatar,coalesce(sum(a.points),0)::bigint
 from public.participants p left join public.attempts a on a.participant_id=p.id
 where p.active=true group by p.id order by 4 desc,p.name
 limit least(greatest(p_limit,1),1000)
$$;

-- 10) Exportação e view administrativa preservadas/atualizadas.
create or replace function public.admin_export_leaderboard()
returns table(name text,sector text,points bigint)
language plpgsql security definer set search_path=public
as $$
begin
 if not public.is_sipat_admin() then raise exception 'Acesso restrito'; end if;
 return query select p.name,p.sector,coalesce(sum(a.points),0)::bigint
 from public.participants p left join public.attempts a on a.participant_id=p.id
 where p.active=true group by p.id order by 3 desc,p.name;
end $$;

create or replace view public.admin_attempts_view with (security_invoker=true) as
 select p.name as participant_name,q.day,q.kind,a.correct,a.points,a.created_at
 from public.attempts a join public.participants p on p.id=a.participant_id
 join public.questions q on q.id=a.question_id;

-- 11) Permissões mínimas para RPCs. Tabelas de participantes e respostas não ficam
-- diretamente acessíveis a anon. O frontend consulta dados por funções autorizadas.
revoke all on function public.participant_room_info(text) from public;
revoke all on function public.participant_join_room(text,text,text,text) from public;
revoke all on function public.participant_session_info(text) from public;
revoke all on function public.sipat_resolve_participant(text) from public;
revoke all on function public.admin_create_activate_room(text,smallint) from public;
revoke all on function public.participant_set_avatar(text,text) from public;
revoke all on function public.participant_next_question(text,text) from public;
revoke all on function public.participant_submit_answer(text,uuid,smallint) from public;
revoke all on function public.participant_my_stats(text) from public;
revoke all on function public.public_leaderboard(integer) from public;
revoke all on function public.admin_export_leaderboard() from public;

grant execute on function public.participant_room_info(text) to anon,authenticated;
grant execute on function public.participant_join_room(text,text,text,text) to anon,authenticated;
grant execute on function public.participant_session_info(text) to anon,authenticated;
grant execute on function public.participant_set_avatar(text,text) to anon,authenticated;
grant execute on function public.participant_next_question(text,text) to anon,authenticated;
grant execute on function public.participant_submit_answer(text,uuid,smallint) to anon,authenticated;
grant execute on function public.participant_my_stats(text) to anon,authenticated;
grant execute on function public.public_leaderboard(integer) to anon,authenticated;
grant execute on function public.admin_create_activate_room(text,smallint) to authenticated;
grant execute on function public.admin_export_leaderboard() to authenticated;
grant select on public.sipat_rooms to authenticated;
grant select on public.admin_attempts_view to authenticated;

-- Garantir que o browser não possa gravar diretamente pontos ou respostas.
revoke insert, update, delete on public.attempts from anon, authenticated;
revoke insert, update, delete on public.participants from anon;

commit;

-- PRIMEIRA SALA: depois de executar a migração, entre no painel com a conta admin
-- já existente e crie/ative o código 555 selecionando o Dia 1. Não é necessário
-- inserir a sala manualmente nem criar uma nova conta administrativa.
