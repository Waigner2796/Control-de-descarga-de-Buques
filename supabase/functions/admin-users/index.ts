/**
 * admin-users · Gestión segura de cuentas (usa service_role SOLO en servidor).
 * Acciones:
 *  - create_staff     { organization_id, email, full_name, role_code, position?, all_terminals?, terminal_ids?, scale_ids?, delivery }
 *  - create_customer  { customer_id, email, full_name, permissions?, delivery }
 *  - reset_password   { organization_id, user_id, delivery }
 *  - revoke_sessions  { organization_id, user_id }
 *  - set_status       { organization_id, user_id, scope: 'member'|'customer', status }
 * delivery: 'temp_password' (devuelve UNA vez una contraseña temporal) | 'invite' (correo con enlace de activación)
 * Las contraseñas nunca se almacenan ni se pueden consultar después.
 */
import { handle, HttpError, json, requirePermission, requireUser, serviceClient, userClient } from '../_shared/http.ts';

const STAFF_ROLES = ['master_admin', 'ops_admin', 'supervisor', 'scale_operator', 'analyst', 'signer'];

function tempPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '#%+=?@'];
  const all = sets.join('');
  const pick = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const chars = [...sets.map(pick), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function findUserByEmail(email: string) {
  const svc = serviceClient();
  const { data } = await svc.from('user_profiles').select('user_id').ilike('email', email).maybeSingle();
  if (data?.user_id) return data.user_id as string;
  for (let page = 1; page <= 50; page++) {
    const { data: list, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new HttpError(500, error.message);
    const u = list.users.find((x) => (x.email ?? '').toLowerCase() === email);
    if (u) return u.id;
    if (list.users.length < 200) break;
  }
  return null;
}

/** Crea (o reutiliza) la cuenta de Auth y su perfil. */
async function ensureAccount(email: string, fullName: string, kind: 'staff' | 'customer', delivery: string, actor: string, redirectTo?: string) {
  const svc = serviceClient();
  const existing = await findUserByEmail(email);
  if (existing) return { userId: existing, created: false, tempPassword: null as string | null };
  let userId: string; let pwd: string | null = null;
  if (delivery === 'invite') {
    const { data, error } = await svc.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error) throw new HttpError(400, error.message);
    userId = data.user.id;
  } else {
    pwd = tempPassword();
    const { data, error } = await svc.auth.admin.createUser({ email, password: pwd, email_confirm: true });
    if (error) throw new HttpError(400, error.message);
    userId = data.user.id;
  }
  const { error: pe } = await svc.from('user_profiles').insert({ user_id: userId, full_name: fullName, email, kind, created_by: actor });
  if (pe) throw new HttpError(400, pe.message);
  // Exige cambio de contraseña en el primer ingreso (verificado en servidor).
  const { error: te } = await svc.rpc('worker_register_temp_password', { p_user: userId });
  if (te) throw new HttpError(500, te.message);
  return { userId, created: true, tempPassword: pwd };
}

async function userBelongsToOrg(orgId: string, userId: string) {
  const svc = serviceClient();
  const [{ data: m }, { data: c }] = await Promise.all([
    svc.from('organization_members').select('id').eq('organization_id', orgId).eq('user_id', userId).maybeSingle(),
    svc.from('customer_users').select('id').eq('organization_id', orgId).eq('user_id', userId).maybeSingle(),
  ]);
  return { member: !!m, customer: !!c };
}

/** Si el usuario ya no tiene ninguna pertenencia activa, se bloquea en Auth. */
async function syncBan(userId: string) {
  const svc = serviceClient();
  const [{ count: m }, { count: c }, { data: pa }] = await Promise.all([
    svc.from('organization_members').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active'),
    svc.from('customer_users').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'active'),
    svc.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
  ]);
  const active = (m ?? 0) + (c ?? 0) > 0 || !!pa;
  await svc.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' });
  if (!active) await svc.rpc('worker_revoke_sessions', { p_user: userId });
  return active;
}

Deno.serve(handle(async (req) => {
  const actor = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const svc = serviceClient();
  const action = String(body.action ?? '');
  const delivery = body.delivery === 'invite' ? 'invite' : 'temp_password';
  const redirectTo = typeof body.redirect_to === 'string' ? body.redirect_to : undefined;

  if (action === 'create_staff') {
    const orgId = String(body.organization_id ?? '');
    const email = String(body.email ?? '').trim().toLowerCase();
    const role = String(body.role_code ?? '');
    if (!emailOk(email)) throw new HttpError(400, 'Correo inválido');
    if (!STAFF_ROLES.includes(role)) throw new HttpError(400, 'Rol inválido');
    const { data: platform } = await svc.from('platform_admins').select('user_id').eq('user_id', actor.id).maybeSingle();
    if (!platform) {
      await requirePermission(req, orgId, 'users.manage');
      if (role === 'master_admin') {
        const { data: me } = await svc.from('organization_members').select('role_code').eq('organization_id', orgId).eq('user_id', actor.id).single();
        if (me?.role_code !== 'master_admin') throw new HttpError(403, 'Solo un Administrador Master puede crear otro Administrador Master');
      }
    }
    const acc = await ensureAccount(email, String(body.full_name ?? '').trim(), 'staff', delivery, actor.id, redirectTo);
    const { data: custRow } = await svc.from('customer_users').select('id').eq('user_id', acc.userId).limit(1);
    if (custRow?.length) throw new HttpError(400, 'Ese correo pertenece a un usuario del portal de clientes; use otro correo');
    const { error: me } = await svc.from('organization_members').insert({
      organization_id: orgId, user_id: acc.userId, role_code: role, created_by: actor.id,
      all_terminals: body.all_terminals !== false, position: body.position ?? null,
    });
    if (me) throw new HttpError(400, me.code === '23505' ? 'El usuario ya pertenece a la empresa' : me.message);
    const terms: string[] = Array.isArray(body.terminal_ids) ? body.terminal_ids : [];
    if (terms.length) {
      const { data: valid } = await svc.from('terminals').select('id').eq('organization_id', orgId).in('id', terms);
      if (valid?.length) await svc.from('terminal_members').insert(valid.map((t) => ({ terminal_id: t.id, user_id: acc.userId, organization_id: orgId })));
    }
    const scales: string[] = Array.isArray(body.scale_ids) ? body.scale_ids : [];
    if (scales.length) {
      const { data: valid } = await svc.from('scales').select('id, terminal_id').eq('organization_id', orgId).in('id', scales);
      if (valid?.length) await svc.from('scale_users').insert(valid.map((s) => ({ scale_id: s.id, user_id: acc.userId, organization_id: orgId, terminal_id: s.terminal_id })));
    }
    await syncBan(acc.userId);
    return json(req, { user_id: acc.userId, created: acc.created, temp_password: acc.tempPassword, delivery: acc.created ? delivery : 'existing' });
  }

  if (action === 'create_customer') {
    const customerId = String(body.customer_id ?? '');
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!emailOk(email)) throw new HttpError(400, 'Correo inválido');
    const { data: cust } = await svc.from('customers').select('id, organization_id, status').eq('id', customerId).maybeSingle();
    if (!cust) throw new HttpError(404, 'Cliente inexistente');
    await requirePermission(req, cust.organization_id, 'portal_users.manage');
    const acc = await ensureAccount(email, String(body.full_name ?? '').trim(), 'customer', delivery, actor.id, redirectTo);
    const { data: staffRow } = await svc.from('organization_members').select('id').eq('user_id', acc.userId).limit(1);
    if (staffRow?.length) throw new HttpError(400, 'Ese correo pertenece a un usuario interno; use otro correo para el portal');
    const { data: cu, error: ce } = await svc.from('customer_users').insert({ customer_id: customerId, user_id: acc.userId, organization_id: cust.organization_id, created_by: actor.id }).select('id').single();
    if (ce) throw new HttpError(400, ce.code === '23505' ? 'El usuario ya tiene acceso a este cliente' : ce.message);
    const p = body.permissions ?? {};
    await svc.from('customer_portal_permissions').insert({
      customer_user_id: cu.id, organization_id: cust.organization_id, customer_id: customerId,
      can_view_reports: p.can_view_reports !== false, can_download_reports: p.can_download_reports !== false,
      can_view_documents: p.can_view_documents !== false, can_view_productivity: p.can_view_productivity !== false,
    });
    await syncBan(acc.userId);
    return json(req, { user_id: acc.userId, customer_user_id: cu.id, created: acc.created, temp_password: acc.tempPassword, delivery: acc.created ? delivery : 'existing' });
  }

  const orgId = String(body.organization_id ?? '');
  const userId = String(body.user_id ?? '');
  const rel = await userBelongsToOrg(orgId, userId);
  if (!rel.member && !rel.customer) throw new HttpError(404, 'El usuario no pertenece a esta empresa');
  await requirePermission(req, orgId, rel.member ? 'users.manage' : 'portal_users.manage');
  if (userId === actor.id) throw new HttpError(400, 'Use su perfil para gestionar su propia cuenta');

  const { data: other } = await svc.from('organization_members').select('organization_id').eq('user_id', userId).neq('organization_id', orgId).eq('status', 'active').limit(1);
  const sharedAccount = !!other?.length;

  if (action === 'reset_password') {
    if (sharedAccount) throw new HttpError(403, 'El usuario pertenece también a otra empresa; debe restablecer su contraseña por correo');
    const { data: u } = await svc.auth.admin.getUserById(userId);
    if (delivery === 'invite') {
      const { error } = await svc.auth.resetPasswordForEmail(u.user?.email ?? '', { redirectTo });
      if (error) throw new HttpError(400, error.message);
      return json(req, { ok: true, delivery });
    }
    const pwd = tempPassword();
    const { error } = await svc.auth.admin.updateUserById(userId, { password: pwd });
    if (error) throw new HttpError(400, error.message);
    await svc.rpc('worker_register_temp_password', { p_user: userId });
    await svc.rpc('worker_revoke_sessions', { p_user: userId });
    return json(req, { ok: true, temp_password: pwd, delivery });
  }

  if (action === 'revoke_sessions') {
    if (sharedAccount) throw new HttpError(403, 'El usuario pertenece también a otra empresa; desactive su acceso en lugar de cerrar sus sesiones');
    await svc.rpc('worker_revoke_sessions', { p_user: userId });
    return json(req, { ok: true });
  }

  if (action === 'set_status') {
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    const uc = userClient(req);
    if (body.scope === 'customer') {
      const { data: cu } = await svc.from('customer_users').select('id').eq('organization_id', orgId).eq('user_id', userId);
      for (const row of cu ?? []) {
        const { error } = await uc.rpc('admin_set_customer_user_status', { p_customer_user: row.id, p_status: status });
        if (error) throw new HttpError(400, error.message);
      }
    } else {
      const { data: m } = await svc.from('organization_members').select('id').eq('organization_id', orgId).eq('user_id', userId).single();
      const { error } = await uc.rpc('admin_update_member', { p_member: m!.id, p: { status, reason: body.reason ?? null } });
      if (error) throw new HttpError(400, error.message);
    }
    const active = await syncBan(userId);
    // Las políticas RLS cortan el acceso de inmediato; además se cierran sesiones si la cuenta no es compartida.
    if (status === 'inactive' && !sharedAccount) await svc.rpc('worker_revoke_sessions', { p_user: userId });
    return json(req, { ok: true, account_active: active });
  }

  throw new HttpError(400, 'Acción inválida');
}));
