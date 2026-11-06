BEGIN;

-- =========================================================
-- SIPAT CHALLENGE
-- CORREÇÃO / MIGRAÇÃO
-- =========================================================

-- ---------------------------------------------------------
-- PARTICIPANTE: ENTRAR NA SALA
-- ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.participant_join_room(
  p_room_code text,
  p_name text,
  p_sector text,
  p_avatar text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room record;
  v_participant record;

  v_name text;
  v_sector text;
  v_avatar text;

  v_access_code text;
  v_session_token text;

  v_name_normalized text;
  v_sector_normalized text;
BEGIN

  v_name :=
    regexp_replace(
      trim(coalesce(p_name, '')),
      '\s+',
      ' ',
      'g'
    );

  v_sector :=
    regexp_replace(
      trim(coalesce(p_sector, '')),
      '\s+',
      ' ',
      'g'
    );

  v_avatar :=
    trim(coalesce(p_avatar, '🙂'));

  IF v_name = '' THEN
    RAISE EXCEPTION 'Informe o nome.';
  END IF;

  IF v_sector = '' THEN
    RAISE EXCEPTION 'Informe o setor.';
  END IF;

  IF length(v_name) > 80 THEN
    RAISE EXCEPTION 'Nome muito longo.';
  END IF;

  IF length(v_sector) > 80 THEN
    RAISE EXCEPTION 'Setor muito longo.';
  END IF;

  SELECT *
  INTO v_room
  FROM public.sipat_rooms
  WHERE upper(room_code) =
        upper(trim(p_room_code))
    AND active = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Sala não encontrada ou inativa.';
  END IF;

  v_name_normalized :=
    lower(
      regexp_replace(
        trim(v_name),
        '\s+',
        ' ',
        'g'
      )
    );

  v_sector_normalized :=
    lower(
      regexp_replace(
        trim(v_sector),
        '\s+',
        ' ',
        'g'
      )
    );

  -- Evita criação simultânea de perfis iguais.
  PERFORM pg_advisory_xact_lock(
    hashtext(
      'sipat_profile:' ||
      v_name_normalized ||
      ':' ||
      v_sector_normalized
    )
  );

  /*
    Primeiro tenta encontrar um perfil ativo
    já existente.

    Dá preferência ao participante da sala atual.
  */
  SELECT *
  INTO v_participant
  FROM public.participants p
  WHERE p.active = true
    AND lower(
      regexp_replace(
        trim(p.name),
        '\s+',
        ' ',
        'g'
      )
    ) = v_name_normalized
    AND lower(
      regexp_replace(
        trim(p.sector),
        '\s+',
        ' ',
        'g'
      )
    ) = v_sector_normalized
  ORDER BY
    CASE
      WHEN p.room_id = v_room.id THEN 0
      ELSE 1
    END,
    (
      SELECT count(*)
      FROM public.attempts a
      WHERE a.participant_id = p.id
    ) DESC,
    p.created_at DESC
  LIMIT 1;

  v_access_code :=
    upper(
      substr(
        encode(
          gen_random_bytes(8),
          'hex'
        ),
        1,
        12
      )
    );

  v_session_token :=
    encode(
      gen_random_bytes(32),
      'hex'
    );

  IF FOUND THEN

    UPDATE public.participants
    SET
      room_id = v_room.id,
      avatar = v_avatar,
      active = true,
      access_code_hash =
        encode(
          digest(
            upper(v_access_code),
            'sha256'
          ),
          'hex'
        ),
      session_token_hash =
        encode(
          digest(
            v_session_token,
            'sha256'
          ),
          'hex'
        ),
      updated_at = now()
    WHERE id = v_participant.id;

  ELSE

    INSERT INTO public.participants (
      room_id,
      name,
      sector,
      avatar,
      active,
      access_code_hash,
      session_token_hash,
      created_at,
      updated_at
    )
    VALUES (
      v_room.id,
      v_name,
      v_sector,
      v_avatar,
      true,
      encode(
        digest(
          upper(v_access_code),
          'sha256'
        ),
        'hex'
      ),
      encode(
        digest(
          v_session_token,
          'sha256'
        ),
        'hex'
      ),
      now(),
      now()
    )
    RETURNING *
    INTO v_participant;

  END IF;

  RETURN jsonb_build_object(
    'participant_id',
    v_participant.id,

    'name',
    v_participant.name,

    'sector',
    v_participant.sector,

    'avatar',
    v_participant.avatar,

    'room_id',
    v_room.id,

    'room_code',
    v_room.room_code,

    'room_name',
    v_room.room_name,

    'access_token',
    v_access_code,

    'session_token',
    v_session_token
  );

END;
$$;


-- =========================================================
-- PRÓXIMA PERGUNTA
-- =========================================================

CREATE OR REPLACE FUNCTION public.participant_next_question(
  p_access_code text,
  p_kind text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_participant record;
  v_room record;

  v_event_day integer;

  v_enabled boolean;
  v_daily_limit integer;

  v_answered integer;

  v_question record;
BEGIN

  SELECT *
  INTO v_participant
  FROM public.participants
  WHERE active = true
    AND access_code_hash =
      encode(
        digest(
          upper(trim(p_access_code)),
          'sha256'
        ),
        'hex'
      )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Participante não encontrado.';
  END IF;

  IF v_participant.room_id IS NULL THEN

    SELECT *
    INTO v_room
    FROM public.sipat_rooms
    WHERE active = true
    ORDER BY created_at DESC
    LIMIT 1;

    IF FOUND THEN

      UPDATE public.participants
      SET
        room_id = v_room.id,
        updated_at = now()
      WHERE id = v_participant.id;

      v_participant.room_id =
        v_room.id;

    END IF;

  END IF;

  SELECT *
  INTO v_room
  FROM public.sipat_rooms
  WHERE id = v_participant.room_id
    AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Sala ativa não encontrada.';
  END IF;

  v_event_day :=
    greatest(
      1,
      (
        current_date -
        coalesce(
          v_room.event_start_date,
          (
            SELECT event_start_date
            FROM public.sipat_settings
            LIMIT 1
          ),
          current_date
        )
      )::integer + 1
    );

  IF v_event_day < 1
     OR v_event_day > 5 THEN

    RETURN jsonb_build_object(
      'available',
      false,
      'message',
      'Não há desafio disponível neste período.'
    );

  END IF;

  SELECT
    coalesce(enabled, true),
    coalesce(daily_limit, 1)
  INTO
    v_enabled,
    v_daily_limit
  FROM public.sipat_mode_settings
  WHERE kind = p_kind
  LIMIT 1;

  IF NOT FOUND THEN

    v_enabled := true;
    v_daily_limit :=
      CASE
        WHEN p_kind = 'bonus'
          THEN 1
        ELSE 1
      END;

  END IF;

  IF NOT v_enabled THEN

    RETURN jsonb_build_object(
      'available',
      false,
      'message',
      'Este modo está desativado.'
    );

  END IF;

  SELECT count(*)
  INTO v_answered
  FROM public.attempts a
  INNER JOIN public.questions q
    ON q.id = a.question_id
  WHERE a.participant_id =
        v_participant.id
    AND q.day = v_event_day
    AND q.kind = p_kind;

  IF v_answered >= v_daily_limit THEN

    RETURN jsonb_build_object(
      'available',
      false,
      'message',
      'Você já atingiu o limite deste desafio hoje.'
    );

  END IF;

  SELECT q.*
  INTO v_question
  FROM public.questions q
  WHERE q.active = true
    AND q.day = v_event_day
    AND q.kind = p_kind
    AND NOT EXISTS (
      SELECT 1
      FROM public.attempts a
      WHERE a.participant_id =
            v_participant.id
        AND a.question_id =
            q.id
    )
  ORDER BY
    CASE
      WHEN p_kind = 'official'
        THEN q.created_at
      ELSE NULL
    END ASC,
    random()
  LIMIT 1;

  IF NOT FOUND THEN

    RETURN jsonb_build_object(
      'available',
      false,
      'message',
      'Não há perguntas disponíveis.'
    );

  END IF;

  RETURN jsonb_build_object(
    'available',
    true,
    'id',
    v_question.id,
    'question_id',
    v_question.id,
    'kind',
    v_question.kind,
    'day',
    v_question.day,
    'points',
    v_question.points,
    'question',
    v_question.question,
    'options',
    v_question.options
  );

END;
$$;


-- =========================================================
-- RESPONDER PERGUNTA
-- =========================================================

CREATE OR REPLACE FUNCTION public.participant_submit_answer(
  p_access_code text,
  p_question_id uuid,
  p_selected_index integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_participant record;
  v_room record;
  v_question record;

  v_event_day integer;

  v_enabled boolean;
  v_daily_limit integer;

  v_answered integer;

  v_correct boolean;
  v_points integer;
BEGIN

  SELECT *
  INTO v_participant
  FROM public.participants
  WHERE active = true
    AND access_code_hash =
      encode(
        digest(
          upper(trim(p_access_code)),
          'sha256'
        ),
        'hex'
      )
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Participante não encontrado.';
  END IF;

  -- Lock do participante.
  -- Evita duas respostas simultâneas
  -- para o mesmo perfil.
  PERFORM 1
  FROM public.participants
  WHERE id = v_participant.id
  FOR UPDATE;

  SELECT *
  INTO v_room
  FROM public.sipat_rooms
  WHERE id = v_participant.room_id
    AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Sala ativa não encontrada.';
  END IF;

  v_event_day :=
    greatest(
      1,
      (
        current_date -
        coalesce(
          v_room.event_start_date,
          (
            SELECT event_start_date
            FROM public.sipat_settings
            LIMIT 1
          ),
          current_date
        )
      )::integer + 1
    );

  IF v_event_day < 1
     OR v_event_day > 5 THEN

    RAISE EXCEPTION
      'Desafio fora do período da SIPAT.';

  END IF;

  SELECT *
  INTO v_question
  FROM public.questions
  WHERE id = p_question_id
    AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Pergunta não encontrada ou inativa.';
  END IF;

  IF v_question.day <> v_event_day THEN
    RAISE EXCEPTION
      'Esta pergunta não está disponível hoje.';
  END IF;

  SELECT
    coalesce(enabled, true),
    coalesce(daily_limit, 1)
  INTO
    v_enabled,
    v_daily_limit
  FROM public.sipat_mode_settings
  WHERE kind = v_question.kind
  LIMIT 1;

  IF NOT FOUND THEN
    v_enabled := true;
    v_daily_limit := 1;
  END IF;

  IF NOT v_enabled THEN
    RAISE EXCEPTION
      'Este modo está desativado.';
  END IF;

  SELECT count(*)
  INTO v_answered
  FROM public.attempts a
  INNER JOIN public.questions q
    ON q.id = a.question_id
  WHERE a.participant_id =
        v_participant.id
    AND q.day = v_event_day
    AND q.kind = v_question.kind;

  IF v_answered >= v_daily_limit THEN
    RAISE EXCEPTION
      'Você já atingiu o limite deste desafio hoje.';
  END IF;

  IF p_selected_index IS NULL
     OR p_selected_index < 0
     OR p_selected_index >=
        jsonb_array_length(
          v_question.options
        ) THEN

    RAISE EXCEPTION
      'Alternativa inválida.';

  END IF;

  v_correct :=
    p_selected_index =
    v_question.correct_index;

  IF v_correct THEN
    v_points :=
      coalesce(
        v_question.points,
        0
      );
  ELSE
    v_points := 0;
  END IF;

  BEGIN

    INSERT INTO public.attempts (
      participant_id,
      question_id,
      selected_index,
      is_correct,
      points_awarded,
      created_at
    )
    VALUES (
      v_participant.id,
      v_question.id,
      p_selected_index,
      v_correct,
      v_points,
      now()
    );

  EXCEPTION
    WHEN unique_violation THEN

      RETURN jsonb_build_object(
        'success',
        false,
        'duplicate',
        true,
        'correct',
        false,
        'points',
        0,
        'points_awarded',
        0,
        'message',
        'Esta pergunta já foi respondida.'
      );

  END;

  RETURN jsonb_build_object(
    'success',
    true,
    'duplicate',
    false,
    'correct',
    v_correct,
    'is_correct',
    v_correct,
    'points',
    v_points,
    'points_awarded',
    v_points
  );

END;
$$;


-- =========================================================
-- LISTAR PARTICIPANTES — ADMIN
-- =========================================================

CREATE OR REPLACE FUNCTION public.admin_list_participants()
RETURNS TABLE (
  participant_id uuid,
  name text,
  sector text,
  avatar text,
  points bigint,
  answers bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

  IF NOT public.is_sipat_admin() THEN
    RAISE EXCEPTION
      'Acesso negado.';
  END IF;

  RETURN QUERY
  SELECT
    p.id AS participant_id,
    p.name,
    p.sector,
    p.avatar,

    coalesce(
      sum(
        CASE
          WHEN a.is_correct
            THEN a.points_awarded
          ELSE 0
        END
      ),
      0
    )::bigint AS points,

    count(a.id)::bigint AS answers

  FROM public.participants p

  LEFT JOIN public.attempts a
    ON a.participant_id = p.id

  WHERE p.active = true

  GROUP BY
    p.id,
    p.name,
    p.sector,
    p.avatar

  ORDER BY
    points DESC,
    p.name ASC;

END;
$$;


-- =========================================================
-- EXCLUIR PARTICIPANTE — ADMIN
-- =========================================================

CREATE OR REPLACE FUNCTION public.admin_delete_participant(
  p_participant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_participant record;
BEGIN

  IF NOT public.is_sipat_admin() THEN
    RAISE EXCEPTION
      'Acesso negado.';
  END IF;

  SELECT *
  INTO v_participant
  FROM public.participants
  WHERE id = p_participant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Participante não encontrado.';
  END IF;

  DELETE FROM public.attempts
  WHERE participant_id =
        p_participant_id;

  DELETE FROM public.participants
  WHERE id =
        p_participant_id;

  RETURN jsonb_build_object(
    'success',
    true,
    'participant_id',
    p_participant_id,
    'name',
    v_participant.name
  );

END;
$$;


-- =========================================================
-- PERMISSÕES
-- =========================================================

REVOKE ALL
ON FUNCTION public.participant_join_room(
  text,
  text,
  text,
  text
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.participant_join_room(
  text,
  text,
  text,
  text
)
TO anon, authenticated;


REVOKE ALL
ON FUNCTION public.participant_next_question(
  text,
  text
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.participant_next_question(
  text,
  text
)
TO anon, authenticated;


REVOKE ALL
ON FUNCTION public.participant_submit_answer(
  text,
  uuid,
  integer
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.participant_submit_answer(
  text,
  uuid,
  integer
)
TO anon, authenticated;


REVOKE ALL
ON FUNCTION public.admin_list_participants()
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.admin_list_participants()
TO authenticated;


REVOKE ALL
ON FUNCTION public.admin_delete_participant(uuid)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.admin_delete_participant(uuid)
TO authenticated;


-- =========================================================
-- RECARREGAR CACHE DO POSTGREST
-- =========================================================

NOTIFY pgrst, 'reload schema';

COMMIT;
