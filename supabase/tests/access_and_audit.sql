\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values (
  '9dc33f21-acc1-4c04-8adf-68bc3c413aad', 'db-test-admin@example.invalid',
  '{"full_name":"Administrador"}', '{}', now(), now()
);
update public.profiles set role = 'admin', active = true where id = '9dc33f21-acc1-4c04-8adf-68bc3c413aad';

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('4bbb5288-f3ec-4b4c-af00-67ec9bfa6601', 'db-test-operator-a@example.invalid',
    '{"full_name":"Operadora A","role":"admin"}',
    '{"provisioned_by":"9dc33f21-acc1-4c04-8adf-68bc3c413aad"}', now(), now()),
  ('4bbb5288-f3ec-4b4c-af00-67ec9bfa6602', 'db-test-operator-b@example.invalid',
    '{"full_name":"Operador B"}', '{}', now(), now()),
  ('4bbb5288-f3ec-4b4c-af00-67ec9bfa6603', 'db-test-second-admin@example.invalid',
    '{"full_name":"Segundo administrador"}',
    '{"provisioned_by":"9dc33f21-acc1-4c04-8adf-68bc3c413aad","provisioned_role":"admin"}', now(), now());

do $$
begin
  if (select active from public.profiles where id = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6602') is distinct from false then
    raise exception 'Una cuenta sin aprovisionamiento administrativo obtuvo un perfil activo';
  end if;
end;
$$;

update auth.users
set raw_app_meta_data = '{"provisioned_by":"9dc33f21-acc1-4c04-8adf-68bc3c413aad","provisioned_role":"operator"}'
where id = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6602';
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"provider":"email"}'
where id = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6602';

do $$
begin
  begin
    insert into auth.users (id, email, raw_app_meta_data, created_at, updated_at)
    values (
      '4bbb5288-f3ec-4b4c-af00-67ec9bfa6604', 'db-test-rejected@example.invalid',
      '{"provisioned_by":"4bbb5288-f3ec-4b4c-af00-67ec9bfa6601","provisioned_role":"admin"}', now(), now()
    );
    raise exception 'El aprovisionamiento aceptó un operador como administrador';
  exception when insufficient_privilege then null;
  end;

  if exists (select 1 from auth.users where id = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6604') then
    raise exception 'Falló la reversión del alta rechazada';
  end if;
end;
$$;

set local role authenticated;
set local "request.jwt.claim.sub" = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6601';

do $$
declare
  v_actor uuid := '4bbb5288-f3ec-4b4c-af00-67ec9bfa6601';
begin
  if (select count(*) from public.profiles) <> 1 or
    (select role from public.profiles) is distinct from 'operator' then
    raise exception 'Exposición de perfiles ajenos o confianza en metadatos de usuario';
  end if;
  if has_function_privilege('public.register_conversion(uuid,text,text,jsonb,timestamptz)', 'execute')
    or has_function_privilege('public.record_review(uuid,uuid,text,text,jsonb)', 'execute')
    or has_function_privilege('public.record_export(uuid,uuid,text,text,text,jsonb,text)', 'execute')
    or has_function_privilege('public.record_processing_failure(uuid,text,text,text)', 'execute') then
    raise exception 'Un operador obtuvo acceso directo a un procedimiento del servidor';
  end if;
  begin
    perform public.register_conversion(v_actor, 'salida.pdf', repeat('a', 64), '{}');
    raise exception 'Un operador registró una extracción directamente';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.audit_events set user_name = 'Modificado' where id is null;
    raise exception 'Un operador modificó un evento';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.update_profile(v_actor, 'A', 'admin', true);
    raise exception 'Un operador cambió roles';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
set local role service_role;

do $$
declare
  v_actor uuid := '4bbb5288-f3ec-4b4c-af00-67ec9bfa6601';
  v_pdf public.conversions;
  v_copy public.conversions;
  v_review public.audit_events;
  v_export public.audit_events;
  v_new_approval public.audit_events;
  v_failed public.audit_events;
  v_uploaded_at timestamptz := clock_timestamp() - interval '2 seconds';
begin
  v_pdf := public.register_conversion(v_actor, 'salida.pdf', repeat('a', 64), '{"rows":[]}', v_uploaded_at);
  if v_pdf.uploaded_at is distinct from v_uploaded_at or v_pdf.processed_at <= v_pdf.uploaded_at then
    raise exception 'El registro no distinguió las fechas de carga y procesamiento';
  end if;
  v_copy := public.register_conversion(v_actor, 'renombrado.pdf', repeat('a', 64), '{"rows":[{}]}');
  if v_pdf.id is distinct from v_copy.id or v_copy.filename <> 'salida.pdf' or v_copy.extraction <> '{"rows":[]}'::jsonb
    or v_copy.uploaded_at is distinct from v_pdf.uploaded_at or v_copy.processed_at is distinct from v_pdf.processed_at then
    raise exception 'El duplicado alteró una extracción o creó otro evento';
  end if;
  perform set_config('conversor_test.first_conversion', v_pdf.id::text, true);

  begin
    perform public.record_export(
      v_actor, v_pdf.id, '000459', 'SALIDA 000459.xlsx', repeat('b', 64), '{"changes":[{"field":"costo"}]}', null
    );
    raise exception 'La exportación fue aprobada sin revisión previa';
  exception when invalid_parameter_value then null;
  end;
  v_review := public.record_review(v_actor, v_pdf.id, '000459', repeat('b', 64), '{"changes":[{"field":"costo"}]}');
  if v_review.id is distinct from
    (public.record_review(v_actor, v_pdf.id, '000459', repeat('b', 64), '{"changes":[{"field":"costo"}]}')).id then
    raise exception 'La revisión repetida creó otro evento';
  end if;
  v_export := public.record_export(
    v_actor, v_pdf.id, '000459', 'SALIDA 000459.xlsx', repeat('b', 64), '{"changes":[{"field":"costo"}]}', ' Aceptado '
  );
  if v_export.id is distinct from (public.record_export(
    v_actor, v_pdf.id, '000459', 'SALIDA 000459.xlsx', repeat('b', 64), '{"changes":[{"field":"costo"}]}', 'Aceptado'
  )).id or v_review.id = v_export.id or v_export.details ->> 'acceptance' <> 'Aceptado'
    or v_export.details ->> 'review_id' is distinct from v_review.id::text then
    raise exception 'Falló la separación o deduplicación de revisión y exportación';
  end if;
  if v_export.details -> 'preview' -> 'changes' <> '[{"field":"costo"}]'::jsonb then
    raise exception 'Las correcciones no quedaron registradas';
  end if;
  v_new_approval := public.record_export(
    v_actor, v_pdf.id, '000459', 'SALIDA 000459.xlsx', repeat('b', 64), '{"changes":[{"field":"costo"}]}',
    'Nueva aceptación'
  );
  if v_new_approval.id = v_export.id or v_new_approval.details ->> 'review_id' is distinct from v_review.id::text then
    raise exception 'Una justificación distinta debe generar otra aprobación para la misma revisión';
  end if;
  begin
    perform public.record_export(
      v_actor, v_pdf.id, '000459', 'SALIDA 000459.xlsx', repeat('b', 64), '{"changes":[{"field":"unidades"}]}', 'Aceptado'
    );
    raise exception 'La misma huella aceptó una vista previa diferente';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.record_export(
      v_actor, v_pdf.id, '000459', 'SALIDA 459.xlsx', repeat('b', 64), '{"changes":[{"field":"costo"}]}', 'Aceptado'
    );
    raise exception 'El nombre de exportación perdió ceros iniciales';
  exception when invalid_parameter_value then null;
  end;

  v_failed := public.record_processing_failure(v_actor, 'parcial.pdf', repeat('c', 64), 'Tiempo agotado');
  if v_failed.event_type <> 'processing_failed' or v_failed.conversion_id is not null then
    raise exception 'El intento fallido quedó asociado a una conversión';
  end if;
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6602';

do $$
begin
  if exists (select 1 from public.conversions) or exists (select 1 from public.audit_events) then
    raise exception 'Un operador vio conversiones o auditorías de otro usuario';
  end if;
end;
$$;

reset role;
set local role service_role;

do $$
declare
  v_actor uuid := '4bbb5288-f3ec-4b4c-af00-67ec9bfa6602';
  v_admin uuid := '9dc33f21-acc1-4c04-8adf-68bc3c413aad';
  v_other uuid := current_setting('conversor_test.first_conversion')::uuid;
  v_pdf public.conversions;
begin
  begin
    perform public.record_review(v_actor, v_other, '000459', repeat('b', 64), '{}');
    raise exception 'Un operador modificó la revisión de otro usuario';
  exception when no_data_found then null;
  end;
  v_pdf := public.register_conversion(v_actor, 'salida.pdf', repeat('a', 64), '{"rows":[]}');
  if v_pdf.id = v_other then
    raise exception 'La deduplicación cruzó perfiles';
  end if;
  perform public.record_review(v_admin, v_other, '000459', repeat('b', 64), '{}');
  perform public.record_export(v_admin, v_other, '000459', 'SALIDA 000459.xlsx', repeat('b', 64), '{}', null);
end;
$$;

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '9dc33f21-acc1-4c04-8adf-68bc3c413aad';

do $$
declare
  v_other uuid := current_setting('conversor_test.first_conversion')::uuid;
  v_target uuid := '4bbb5288-f3ec-4b4c-af00-67ec9bfa6601';
  v_actor uuid := '9dc33f21-acc1-4c04-8adf-68bc3c413aad';
  v_second_operator uuid := '4bbb5288-f3ec-4b4c-af00-67ec9bfa6602';
  v_other_admin uuid := '4bbb5288-f3ec-4b4c-af00-67ec9bfa6603';
begin
  if (select count(*) from public.profiles where id in (v_actor, v_target, v_second_operator, v_other_admin)) <> 4
    or (select count(*) from public.conversions where user_id in (v_target, v_second_operator) and sha256 = repeat('a', 64)) <> 2
    or (select count(*) from public.audit_events where event_type = 'user_created' and user_id = v_actor) <> 3 then
    raise exception 'Falló el acceso global o el registro atómico del aprovisionamiento';
  end if;

  if (select count(*) from public.audit_events where event_type = 'export_approved' and conversion_id = v_other) <> 3
    or (select count(*) from public.audit_events where event_type = 'conversion_registered' and conversion_id = v_other) <> 1 then
    raise exception 'Falló el acceso administrativo a una conversión ajena o la deduplicación de altas';
  end if;

  perform public.update_profile(v_target, 'Operadora A inactiva', 'operator', false);
  if (select details -> 'after' ->> 'active' from public.audit_events
    where event_type = 'user_profile_updated' and details ->> 'target_id' = v_target::text) <> 'false'
    or (select user_name from public.audit_events where conversion_id = v_other and event_type = 'conversion_registered')
      <> 'Operadora A' then
    raise exception 'Se perdió el detalle de la desactivación o el nombre histórico';
  end if;

  begin
    perform public.update_profile(v_actor, 'Administrador', 'operator', true);
    raise exception 'Un administrador activo pudo quitarse su rol';
  exception when insufficient_privilege then null;
  end;
  perform public.update_profile(v_other_admin, 'Segundo administrador', 'operator', false);
  begin
    perform public.update_profile(v_actor, 'Administrador', 'admin', false);
    raise exception 'Se pudo desactivar el último administrador activo';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.audit_events where conversion_id = v_other;
    raise exception 'Un administrador de aplicación eliminó auditorías';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local "request.jwt.claim.sub" = '4bbb5288-f3ec-4b4c-af00-67ec9bfa6601';

do $$
begin
  if exists (select 1 from public.profiles) or exists (select 1 from public.conversions)
    or exists (select 1 from public.audit_events) then
    raise exception 'Una cuenta desactivada conservó acceso con su sesión anterior';
  end if;
end;
$$;

reset role;
set local role service_role;

do $$
begin
  begin
    perform public.register_conversion('4bbb5288-f3ec-4b4c-af00-67ec9bfa6601', 'salida.pdf', repeat('a', 64), '{}');
    raise exception 'Una cuenta desactivada registró una conversión';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.audit_events set details = '{}' where id is null;
    raise exception 'El rol del servicio obtuvo permisos de modificación directa de auditoría';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
set local role anon;

do $$
begin
  begin
    perform 1 from public.profiles;
    raise exception 'La sesión anónima accedió a perfiles';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.register_conversion('4bbb5288-f3ec-4b4c-af00-67ec9bfa6601', 'salida.pdf', repeat('a', 64), '{}');
    raise exception 'La sesión anónima accedió al procedimiento';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;

select '1..1';
select 'ok 1 - Aislamiento de usuarios, procedimientos y auditoría de Supabase';
