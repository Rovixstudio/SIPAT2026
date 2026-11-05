-- SIPAT CHALLENGE — CORREÇÃO DE SALA, PERFIL ÚNICO E EXCLUSÃO ADMINISTRATIVA
-- Migração ADITIVA. Não apaga nem reinicia dados existentes.
-- Execute APÓS as migrações de salas e de controle de modos.
begin;

-- 1) Corrige perfis antigos sem sala: ao jogar, são vinculados à sala ativa.
-- Também corrige o cadastro: mesmo nome + setor na SIPAT reutiliza o perfil,
-- preservando respostas e pontos. O avatar pode ser atualizado.
create or replace function public.participant_join_room(
  p_room_code text,
  p_name text,
  p_sector text,
  p_avatar text default '👷'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r public.sipat_rooms;
  existing_p public.participants;
  new_token text;
  normalized_name text;
  normalized_sector text;
begin
  if length(trim(coalesce(p_name,''))) < 2 or length(trim(p_name)) > 80 then
    raise exception 'Informe um nome entre 2 e 80 caracteres';
  end if;
  if length(trim(coalesce(p_sector,''))) < 2 or length(trim(p_sector)) > 80 then
    raise exception 'Informe um setor entre 2 e 80 caracteres';
  end if;
  if length(coalesce(p_avatar,'')) > 16 then
    raise exception 'Avatar inválido';
  end if;

  select * into r
  from public.sipat_rooms
  where code=trim(p_room_code) and active=true
  for share;

  if not found then
    raise exception 'Sala inexistente ou inativa';
  end if;

  normalized_name := lower(regexp_replace(trim(p_name), '\s+', ' ', 'g'));
  normalized_sector := lower(regexp_replace(trim(p_sector), '\s+', ' ', 'g'));

  -- Evita duas entradas simultâneas criarem dois perfis para a mesma pessoa.
  perform pg_advisory_xact_lock(hashtext('sipat_profile:' || normalized_name || ':' || normalized_sector));

  select p.* into existing_p
  from public.participants p
  where p.active=true
    and lower(regexp_replace(trim(p.name), '\s+', ' ', 'g'))=normalized_name
    and lower(regexp_replace(trim(p.sector), '\s+', ' ', 'g'))=normalized_sector
  order by
    case when p.room_id=r.id then 0 else 1 end,
    (select count(*) from public.attempts a where a.participant_id=p.id) desc,
    p.id asc
  limit 1
  for update;

  new_token := encode(gen_random_bytes(32), 'hex');

  if found then
    update public.participants
    set room_id=r.id,
        avatar=coalesce(nullif(p_avatar,''),avatar),
        session_token_hash=encode(digest(new_token,'sha256'),'hex'),
        access_code_hash=encode(digest(upper(new_token),'sha256'),'hex'),
        last_seen_at=now(),
        active=true
    where id=existing_p.id;

    return jsonb_build_object(
      'access_token',new_token,
      'reused',true,
      'participant',jsonb_build_object(
        'id',existing_p.id,
        'name',existing_p.name,
        'sector',existing_p.sector,
        'avatar',coalesce(nullif(p_avatar,''),existing_p.avatar),
        'room_code',r.code,
        'day',r.day
      )
    );
  end if;

  insert into public.participants(
    access_code_hash,session_token_hash,name,sector,avatar,room_id,active
  )
  values(
    encode(digest(upper(new_token),'sha256'),'hex'),
    encode(digest(new_token,'sha256'),'hex'),
    trim(p_name),trim(p_sector),coalesce(nullif(p_avatar,''),'👷'),r.id,true
  )
  returning * into existing_p;

  return jsonb_build_object(
    'access_token',new_token,
    'reused',false,
    'participant',jsonb_build_object(
      'id',existing_p.id,'name',existing_p.name,'sector',existing_p.sector,
      'avatar',existing_p.avatar,'room_code',r.code,'day',r.day
    )
  );
end;
$$;

-- 2) O participante legado sem room_id é associado à sala ativa.
-- Isso evita depender de sipat_settings.event_start_date para participantes que
-- já estão entrando pela sala/QR Code atual.
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
  if p_kind not in ('official','bonus') then raise exception 'Tipo inválido'; end if;
  pid := public.sipat_resolve_participant(p_access_code);

  select * into p from public.participants where id=pid for update;

  if p.room_id is null then
    select * into r from public.sipat_rooms where active=true order by activated_at desc nulls last limit 1;
    if found then
      update public.participants set room_id=r.id,last_seen_at=now() where id=pid;
      p.room_id := r.id;
    end if;
  end if;

  if p.room_id is not null then
    select * into r from public.sipat_rooms where id=p.room_id;
    if not found then raise exception 'Sala vinculada não encontrada'; end if;
    event_day := r.day;
  else
    select event_start_date into event_start from public.sipat_settings where singleton=true;
    if event_start is null then
      raise exception 'Não foi possível identificar o dia da SIPAT. Entre pelo QR Code da sala ativa ou peça ao administrador para ativar uma sala.';
    end if;
    event_day := (current_date-event_start)+1;
  end if;

  if event_day < 1 or event_day > 5 then return jsonb_build_object('status','complete'); end if;

  select enabled,question_limit into v_enabled,v_limit
  from public.sipat_mode_settings where day=event_day and kind=p_kind;
  if not found then
    v_enabled := (p_kind='official');
    v_limit := case when p_kind='official' then 10 else 5 end;
  end if;
  if not v_enabled then
    return jsonb_build_object('status','disabled','message','Este modo foi desativado pela organização.');
  end if;

  select count(*) into v_answered
  from public.attempts a join public.questions qx on qx.id=a.question_id
  where a.participant_id=pid and qx.day=event_day and qx.kind=p_kind;
  if v_answered >= v_limit then
    return jsonb_build_object('status','complete','reason','limit_reached','limit',v_limit);
  end if;

  select * into q from public.questions
  where active=true and kind=p_kind and day=event_day
    and not exists(select 1 from public.attempts a where a.participant_id=pid and a.question_id=questions.id)
  order by case when p_kind='official' then created_at end asc, random()
  limit 1;

  if q.id is null then return jsonb_build_object('status','complete','reason','no_active_questions'); end if;
  return jsonb_build_object('id',q.id,'day',q.day,'kind',q.kind,'prompt',q.prompt,'options',q.options,'points',q.points);
end;
$$;

create or replace function public.participant_submit_answer(
  p_access_code text,p_question_id uuid,p_selected_index smallint
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
  select * into p from public.participants where id=pid for update;

  if p.room_id is null then
    select * into r from public.sipat_rooms where active=true order by activated_at desc nulls last limit 1;
    if found then
      update public.participants set room_id=r.id,last_seen_at=now() where id=pid;
      p.room_id := r.id;
    end if;
  end if;

  if p.room_id is not null then
    select * into r from public.sipat_rooms where id=p.room_id;
    if not found then raise exception 'Sala vinculada não encontrada'; end if;
    event_day := r.day;
  else
    select event_start_date into event_start from public.sipat_settings where singleton=true;
    if event_start is null then raise exception 'Não foi possível identificar o dia da SIPAT'; end if;
    event_day := (current_date-event_start)+1;
  end if;

  if event_day < 1 or event_day > 5 then raise exception 'Período da SIPAT encerrado'; end if;

  select * into q from public.questions where id=p_question_id and active=true;
  if not found then raise exception 'Pergunta indisponível'; end if;
  if q.day <> event_day then raise exception 'Esta pergunta não pertence ao dia da sua sala'; end if;
  if q.kind not in ('official','bonus') then raise exception 'Tipo de pergunta inválido'; end if;

  select enabled,question_limit into v_enabled,v_limit
  from public.sipat_mode_settings where day=event_day and kind=q.kind;
  if not found then
    v_enabled := (q.kind='official');
    v_limit := case when q.kind='official' then 10 else 5 end;
  end if;
  if not v_enabled then raise exception 'Este modo foi desativado pela organização'; end if;

  select count(*) into v_answered
  from public.attempts a join public.questions qx on qx.id=a.question_id
  where a.participant_id=pid and qx.day=event_day and qx.kind=q.kind;
  if v_answered >= v_limit then raise exception 'Limite de % perguntas atingido para este modo',v_limit; end if;

  if p_selected_index is null or p_selected_index < 0 or p_selected_index >= jsonb_array_length(q.options) then
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

-- 3) Lista administrativa de participantes com total de pontos e respostas.
create or replace function public.admin_list_participants()
returns table(
  participant_id uuid,
  name text,
  sector text,
  avatar text,
  points bigint,
  answers bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_sipat_admin() then raise exception 'Acesso restrito a administradores'; end if;
  return query
  select p.id,p.name,p.sector,p.avatar,
         coalesce(sum(a.points),0)::bigint,
         count(a.id)::bigint
  from public.participants p
  left join public.attempts a on a.participant_id=p.id
  where p.active=true
  group by p.id
  order by coalesce(sum(a.points),0) desc,p.name;
end;
$$;

-- 4) Exclui um participante e somente as tentativas/pontos ligados a ele.
create or replace function public.admin_delete_participant(p_participant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_name text;
  deleted_count integer;
begin
  if not public.is_sipat_admin() then raise exception 'Acesso restrito a administradores'; end if;
  if p_participant_id is null then raise exception 'Participante inválido'; end if;

  select name into deleted_name
  from public.participants
  where id=p_participant_id
  for update;

  if not found then raise exception 'Participante não encontrado'; end if;

  delete from public.attempts where participant_id=p_participant_id;
  get diagnostics deleted_count = row_count;

  delete from public.participants where id=p_participant_id;

  return jsonb_build_object(
    'success',true,'name',deleted_name,
    'deleted_attempts',deleted_count
  );
end;
$$;

revoke all on function public.participant_join_room(text,text,text,text) from public;
revoke all on function public.admin_list_participants() from public,anon;
revoke all on function public.admin_delete_participant(uuid) from public,anon;
revoke all on function public.participant_next_question(text,text) from public;
revoke all on function public.participant_submit_answer(text,uuid,smallint) from public;

grant execute on function public.participant_join_room(text,text,text,text) to anon,authenticated;
grant execute on function public.admin_list_participants() to authenticated;
grant execute on function public.admin_delete_participant(uuid) to authenticated;
grant execute on function public.participant_next_question(text,text) to anon,authenticated;
grant execute on function public.participant_submit_answer(text,uuid,smallint) to anon,authenticated;

notify pgrst, 'reload schema';
commit;
