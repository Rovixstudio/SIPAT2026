-- SIPAT CHALLENGE — CONTROLE INDEPENDENTE DO OFICIAL E BÔNUS
-- Migração ADITIVA. Não apaga participantes, perguntas, respostas, salas ou pontos.
-- Execute no SQL Editor do projeto kffdbfmawbdewnlzuqdm APÓS a migração de salas.
begin;

create table if not exists public.sipat_mode_settings (
  day smallint not null check (day between 1 and 5),
  kind text not null check (kind in ('official','bonus')),
  enabled boolean not null default false,
  question_limit integer not null check (question_limit between 1 and 100),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (day, kind)
);

-- Padrão seguro: oficial liberado com limite 10; bônus bloqueado até o admin liberar.
insert into public.sipat_mode_settings(day,kind,enabled,question_limit)
select d, k,
       case when k='official' then true else false end,
       case when k='official' then 10 else 5 end
from generate_series(1,5) as d
cross join (values ('official'),('bonus')) as kinds(k)
on conflict (day,kind) do nothing;

alter table public.sipat_mode_settings enable row level security;
revoke all on public.sipat_mode_settings from anon, authenticated, public;

create or replace function public.admin_get_mode_settings()
returns table(
  day smallint,
  kind text,
  enabled boolean,
  question_limit integer,
  available_questions bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_sipat_admin() then
    raise exception 'Acesso restrito a administradores';
  end if;

  return query
  select s.day, s.kind, s.enabled, s.question_limit,
         (select count(*) from public.questions q
          where q.day=s.day and q.kind=s.kind and q.active=true)::bigint
  from public.sipat_mode_settings s
  order by s.day, s.kind;
end;
$$;

create or replace function public.admin_update_mode_settings(
  p_day smallint,
  p_kind text,
  p_enabled boolean,
  p_question_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_sipat_admin() then
    raise exception 'Acesso restrito a administradores';
  end if;
  if p_day not between 1 and 5 then
    raise exception 'Dia inválido';
  end if;
  if p_kind not in ('official','bonus') then
    raise exception 'Tipo de desafio inválido';
  end if;
  if p_enabled is null or p_question_limit not between 1 and 100 then
    raise exception 'Informe ativação e limite entre 1 e 100';
  end if;

  insert into public.sipat_mode_settings(day,kind,enabled,question_limit,updated_at,updated_by)
  values(p_day,p_kind,p_enabled,p_question_limit,now(),auth.uid())
  on conflict(day,kind) do update
    set enabled=excluded.enabled,
        question_limit=excluded.question_limit,
        updated_at=now(),
        updated_by=auth.uid();

  return jsonb_build_object(
    'success',true,'day',p_day,'kind',p_kind,
    'enabled',p_enabled,'question_limit',p_question_limit
  );
end;
$$;

-- A leitura de perguntas agora respeita liberação e limite individual por modo.
create or replace function public.participant_next_question(p_access_code text, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  pid uuid;
  p public.participants;
  r public.sipat_rooms;
  q public.questions;
  event_start date;
  event_day integer;
  v_enabled boolean;
  v_limit integer;
  v_answered integer;
begin
  if p_kind not in ('official','bonus') then
    raise exception 'Tipo inválido';
  end if;

  pid := public.sipat_resolve_participant(p_access_code);
  select * into p from public.participants where id=pid;

  if p.room_id is not null then
    select * into r from public.sipat_rooms where id=p.room_id;
    if not found then raise exception 'Sala vinculada não encontrada'; end if;
    event_day := r.day;
  else
    select event_start_date into event_start
    from public.sipat_settings where singleton=true;
    if event_start is null then
      raise exception 'Participante sem sala. Entre pelo QR Code ativo.';
    end if;
    event_day := (current_date-event_start)+1;
  end if;

  if event_day < 1 or event_day > 5 then
    return jsonb_build_object('status','complete');
  end if;

  select enabled,question_limit into v_enabled,v_limit
  from public.sipat_mode_settings
  where day=event_day and kind=p_kind;

  if not found then
    v_enabled := (p_kind='official');
    v_limit := case when p_kind='official' then 10 else 5 end;
  end if;

  if not v_enabled then
    return jsonb_build_object('status','disabled','message','Este modo foi desativado pela organização.');
  end if;

  select count(*) into v_answered
  from public.attempts a
  join public.questions qx on qx.id=a.question_id
  where a.participant_id=pid and qx.day=event_day and qx.kind=p_kind;

  if v_answered >= v_limit then
    return jsonb_build_object('status','complete','reason','limit_reached','limit',v_limit);
  end if;

  select * into q
  from public.questions
  where active=true and kind=p_kind and day=event_day
    and not exists(
      select 1 from public.attempts a
      where a.participant_id=pid and a.question_id=questions.id
    )
  order by case when p_kind='official' then created_at end asc, random()
  limit 1;

  if q.id is null then
    return jsonb_build_object('status','complete','reason','no_active_questions');
  end if;

  return jsonb_build_object(
    'id',q.id,'day',q.day,'kind',q.kind,
    'prompt',q.prompt,'options',q.options,'points',q.points
  );
end;
$$;

-- A gravação bloqueia a linha do participante, revalida modo/limite e só então pontua.
-- Repetir chamadas ou tentar enviar respostas extras não ultrapassa o limite.
create or replace function public.participant_submit_answer(
  p_access_code text,
  p_question_id uuid,
  p_selected_index smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  pid uuid;
  p public.participants;
  r public.sipat_rooms;
  q public.questions;
  event_start date;
  event_day integer;
  v_enabled boolean;
  v_limit integer;
  v_answered integer;
  is_correct boolean;
  earned integer;
begin
  pid := public.sipat_resolve_participant(p_access_code);

  -- Serializa envios simultâneos do mesmo participante.
  select * into p from public.participants where id=pid for update;

  if p.room_id is not null then
    select * into r from public.sipat_rooms where id=p.room_id;
    if not found then raise exception 'Sala vinculada não encontrada'; end if;
    event_day := r.day;
  else
    select event_start_date into event_start
    from public.sipat_settings where singleton=true;
    if event_start is null then raise exception 'Participante sem sala'; end if;
    event_day := (current_date-event_start)+1;
  end if;

  if event_day < 1 or event_day > 5 then
    raise exception 'Período da SIPAT encerrado';
  end if;

  select * into q
  from public.questions
  where id=p_question_id and active=true;

  if not found then raise exception 'Pergunta indisponível'; end if;
  if q.day <> event_day then raise exception 'Esta pergunta não pertence ao dia da sua sala'; end if;
  if q.kind not in ('official','bonus') then raise exception 'Tipo de pergunta inválido'; end if;

  select enabled,question_limit into v_enabled,v_limit
  from public.sipat_mode_settings
  where day=event_day and kind=q.kind;

  if not found then
    v_enabled := (q.kind='official');
    v_limit := case when q.kind='official' then 10 else 5 end;
  end if;

  if not v_enabled then
    raise exception 'Este modo foi desativado pela organização';
  end if;

  select count(*) into v_answered
  from public.attempts a
  join public.questions qx on qx.id=a.question_id
  where a.participant_id=pid and qx.day=event_day and qx.kind=q.kind;

  if v_answered >= v_limit then
    raise exception 'Limite de % perguntas atingido para este modo', v_limit;
  end if;

  if p_selected_index is null
     or p_selected_index < 0
     or p_selected_index >= jsonb_array_length(q.options) then
    raise exception 'Alternativa inválida';
  end if;

  is_correct := p_selected_index=q.correct_index;
  earned := case when is_correct then q.points else 0 end;

  insert into public.attempts(participant_id,question_id,selected_index,correct,points)
  values(pid,q.id,p_selected_index,is_correct,earned);

  update public.participants set last_seen_at=now() where id=pid;
  return jsonb_build_object('correct',is_correct,'points',earned,'limit',v_limit,'answered',v_answered+1);

exception when unique_violation then
  raise exception 'Esta pergunta já foi respondida por este participante';
end;
$$;

revoke all on function public.admin_get_mode_settings() from public, anon;
revoke all on function public.admin_update_mode_settings(smallint,text,boolean,integer) from public, anon;
revoke all on function public.participant_next_question(text,text) from public;
revoke all on function public.participant_submit_answer(text,uuid,smallint) from public;

grant execute on function public.admin_get_mode_settings() to authenticated;
grant execute on function public.admin_update_mode_settings(smallint,text,boolean,integer) to authenticated;
grant execute on function public.participant_next_question(text,text) to anon, authenticated;
grant execute on function public.participant_submit_answer(text,uuid,smallint) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
