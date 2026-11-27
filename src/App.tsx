import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { configured } from '@/lib/supabase';
import { Spinner } from '@/components/ui';
import { AdminLayout } from '@/layouts/AdminLayout';
import { PortalLayout } from '@/layouts/PortalLayout';
import { Login, ForgotPassword, ResetPassword, ChangePassword, NoAccess, NotConfigured } from '@/pages/auth/AuthPages';
import { VerifyPage } from '@/pages/auth/Verify';

const Dashboard = lazy(() => import('@/pages/admin/Dashboard'));
const Customers = lazy(() => import('@/pages/admin/Customers'));
const CustomerDetail = lazy(() => import('@/pages/admin/CustomerDetail'));
const Services = lazy(() => import('@/pages/admin/Services'));
const ServiceNew = lazy(() => import('@/pages/admin/ServiceNew'));
const ServiceDetail = lazy(() => import('@/pages/admin/ServiceDetail'));
const Vessels = lazy(() => import('@/pages/admin/Vessels'));
const Scales = lazy(() => import('@/pages/admin/Scales'));
const Weighing = lazy(() => import('@/pages/admin/Weighing'));
const Cycles = lazy(() => import('@/pages/admin/Cycles'));
const Downtime = lazy(() => import('@/pages/admin/Downtime'));
const Productivity = lazy(() => import('@/pages/admin/Productivity'));
const Corrections = lazy(() => import('@/pages/admin/Corrections'));
const Reports = lazy(() => import('@/pages/admin/Reports'));
const Signatures = lazy(() => import('@/pages/admin/Signatures'));
const Users = lazy(() => import('@/pages/admin/Users'));
const Audit = lazy(() => import('@/pages/admin/Audit'));
const Settings = lazy(() => import('@/pages/admin/Settings'));
const Platform = lazy(() => import('@/pages/admin/Platform'));
const Profile = lazy(() => import('@/pages/Profile'));
const PortalHome = lazy(() => import('@/pages/portal/PortalHome'));
const PortalServices = lazy(() => import('@/pages/portal/PortalServices'));
const PortalServiceDetail = lazy(() => import('@/pages/portal/PortalServiceDetail'));
const PortalReports = lazy(() => import('@/pages/portal/PortalReports'));
const PortalDocuments = lazy(() => import('@/pages/portal/PortalDocuments'));

function Loading() {
  return <div className="flex min-h-[50vh] items-center justify-center"><Spinner /></div>;
}

/** Exige sesión, perfil activo y contraseña temporal ya cambiada. */
function RequireSession({ children }: { children: ReactNode }) {
  const { session, ready, ctx, ctxLoading, recovering } = useAuth();
  const loc = useLocation();
  if (!ready || ctxLoading) return <Loading />;
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (recovering) return <Navigate to="/restablecer" replace />;
  if (ctx?.profile?.must_change_password) return <Navigate to="/cambiar-contrasena" replace />;
  if (ctx?.profile && ctx.profile.status !== 'active') return <NoAccess />;
  return <>{children}</>;
}

function RequireStaff({ children }: { children: ReactNode }) {
  const { ctx } = useAuth();
  if (!ctx) return <Loading />;
  if (!ctx.memberships.length && !ctx.is_platform_admin) return ctx.customer_links.length ? <Navigate to="/portal" replace /> : <NoAccess />;
  return <>{children}</>;
}

function RequireCustomer({ children }: { children: ReactNode }) {
  const { ctx } = useAuth();
  if (!ctx) return <Loading />;
  if (!ctx.customer_links.length) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Ruta protegida por permiso (la autorización real la aplica el backend). */
export function Perm({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const list = Array.isArray(perm) ? perm : [perm];
  return list.some(can) ? <>{children}</> : <NoAccess inline />;
}

function Home() {
  const { ctx } = useAuth();
  if (!ctx) return <Loading />;
  if (ctx.memberships.length) return <Navigate to="/app" replace />;
  if (ctx.customer_links.length) return <Navigate to="/portal" replace />;
  if (ctx.is_platform_admin) return <Navigate to="/app/plataforma" replace />;
  return <NoAccess />;
}

export default function App() {
  if (!configured) return <NotConfigured />;
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/recuperar" element={<ForgotPassword />} />
        <Route path="/restablecer" element={<ResetPassword />} />
        <Route path="/verificar" element={<VerifyPage />} />
        <Route path="/verificar/:code" element={<VerifyPage />} />
        <Route path="/cambiar-contrasena" element={<ChangePassword />} />
        <Route path="/" element={<RequireSession><Home /></RequireSession>} />
        <Route path="/app" element={<RequireSession><RequireStaff><AdminLayout /></RequireStaff></RequireSession>}>
          <Route index element={<Dashboard />} />
          <Route path="clientes" element={<Perm perm="customers.view"><Customers /></Perm>} />
          <Route path="clientes/:id" element={<Perm perm="customers.view"><CustomerDetail /></Perm>} />
          <Route path="servicios" element={<Perm perm={['services.view', 'weighing.register']}><Services /></Perm>} />
          <Route path="servicios/nuevo" element={<Perm perm="services.manage"><ServiceNew /></Perm>} />
          <Route path="servicios/:id" element={<Perm perm={['services.view', 'weighing.register']}><ServiceDetail /></Perm>} />
          <Route path="buques" element={<Perm perm={['vessels.manage', 'services.view']}><Vessels /></Perm>} />
          <Route path="basculas" element={<Perm perm={['scales.manage', 'weighing.view_all']}><Scales /></Perm>} />
          <Route path="pesaje" element={<Perm perm="weighing.register"><Weighing /></Perm>} />
          <Route path="ciclos" element={<Perm perm={['weighing.view_all', 'weighing.register']}><Cycles /></Perm>} />
          <Route path="tiempos-perdidos" element={<Perm perm={['downtime.register', 'services.view']}><Downtime /></Perm>} />
          <Route path="productividad" element={<Perm perm="productivity.view"><Productivity /></Perm>} />
          <Route path="correcciones" element={<Perm perm={['corrections.request', 'corrections.approve']}><Corrections /></Perm>} />
          <Route path="reportes" element={<Perm perm="reports.view"><Reports /></Perm>} />
          <Route path="firmas" element={<Perm perm={['signatures.manage', 'reports.sign']}><Signatures /></Perm>} />
          <Route path="usuarios" element={<Perm perm="users.manage"><Users /></Perm>} />
          <Route path="auditoria" element={<Perm perm="audit.view"><Audit /></Perm>} />
          <Route path="configuracion" element={<Perm perm={['org.manage', 'downtime.manage', 'scales.manage']}><Settings /></Perm>} />
          <Route path="plataforma" element={<Platform />} />
          <Route path="perfil" element={<Profile />} />
        </Route>
        <Route path="/portal" element={<RequireSession><RequireCustomer><PortalLayout /></RequireCustomer></RequireSession>}>
          <Route index element={<PortalHome />} />
          <Route path="servicios" element={<PortalServices />} />
          <Route path="servicios/:id" element={<PortalServiceDetail />} />
          <Route path="reportes" element={<PortalReports />} />
          <Route path="documentos" element={<PortalDocuments />} />
          <Route path="perfil" element={<Profile portal />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
