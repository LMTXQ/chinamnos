import type { Env } from './common/env';
import { ERR, fail, ok } from './common/envelope';
import { handleOptions, withCors } from './common/cors';
import { cachedGet } from './common/cache';
import { handleMeta, handleAboutTimeline, handleAboutThanks, handleAboutLinks } from './common/meta';
import { handleNotices } from './common/notices';
import { handleNotificationsList, handleNotificationsRead, handleNotificationsDelete, handleNotificationsClearRead } from './common/notifications';
import { hitLimit } from './common/ratelimit';
import { TEMPLATES } from './mail/templates';
import { notify } from './mail/notifier';
import { handleSendCode } from './auth/send-code';
import { handleLoginParams } from './auth/login-params';
import { handleEmailPolicy } from './auth/email-policy';
import { handleRegister } from './auth/register';
import { handleLogin } from './auth/login';
import { handleResetPassword } from './auth/reset-password';
import { handleLogout } from './auth/logout';
import { handleMe } from './auth/me';
import { handleNickname } from './auth/nickname';
import { handleSetProfile, handlePublicProfile, handleAvatar, handleSetMyAvatar } from './auth/profile';
import { handleSetAvatar } from './admin/users';
import { moduleGuard } from './cardhub/module-guard';
import { handleSchema } from './cardhub/schema-handler';
import { handlePostsList } from './cardhub/posts-list';
import { handlePostDetail } from './cardhub/post-detail';
import { handleCreatePost } from './cardhub/post-create';
import { handleMyPosts } from './cardhub/me-posts';
import { handleMyDeals } from './cardhub/me-deals';
import { handleClosePost, handleWithdrawPost, handleResubmitPost, handleDeletePost, handleUpdatePost } from './cardhub/post-actions';
import { handleAdminPostDetail } from './admin/posts';
import { handleCreateConversation, handleDmCreate, handleAdminConvList, handleConversationHide } from './cardhub/conversations';
import { handleMyConversations, handleReplyMessage, handleConversationDetail } from './cardhub/conversation-messages';
import { handleCreateRelayRequest } from './cardhub/relay-requests';
import { handleFavoriteToggle, handleMyFavorites } from './cardhub/favorites';
import { handlePinPost, handleUnpinPost, handlePinBump } from './cardhub/pin';
import { handleBoardCounts } from './cardhub/posts-list';
import { runCardhubCron } from './cardhub/cron';
import { handleActivityList, handleActivityCreate, handleActivityDelete, handleActivityDetail, handleActivityQr, handleActivityFavoriteToggle, handleMyActivityFavorites, handleActivityPin, handleActivityUnpin, handleAdminActivityList, handleAdminActivityReview, handleAdminActivityRetire, handleAdminActivityDelete, runActivitiesCron } from './activities';
import { handleProofImage } from './cardhub/proofs';
import { handleCommunityList, handleCommunityCreate, handleCommunityDelete, handleCommunityProof } from './communities';
import { handleCreateTicket, handleListTickets, handleTicketDetail, handleTicketReply, handleTicketClose, handleTicketApplyTemplate } from './tickets';
import { handleNavLinks, handleNavSubmit, handleNavAdminList, handleNavReview, handleNavUpdate, handleNavDelete } from './nav';
import { handleExportActs, handleExportChats, handleExportNavlinks } from './export';
import { handlePendingPosts, handleListPosts, handleReviewPost, handleAdminClosePost, handleAdminDeletePost } from './admin/posts';
import { handleListRelayRequests, handleRelayRequest } from './admin/relay';
import { handleListUsers, handleBanUser, handleUnbanUser, handleSetUserRole, handleGetUserProfile, handleSetUserProfile, handleSetTitle } from './admin/users';
import { handleGetSettings, handleUpdateSetting } from './admin/settings';
import { handleStats } from './admin/stats';
import { handleListAuditLogs } from './admin/audit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/mail/test：第 1 期临时 owner 裸接口（X-Owner-Key = CARDHUB_SECRET）。
// 第 2 期账号系统建成后移除，改走正式鉴权链（§7）。
async function handleMailTest(request: Request, env: Env): Promise<Response> {
  if (!env.CARDHUB_SECRET || request.headers.get('X-Owner-Key') !== env.CARDHUB_SECRET) {
    return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  }
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const rl = await hitLimit(env, `mailtest:ip:${ip}`, 20, 3600);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 空/非法 body 用默认值
  }

  const to = typeof body.to === 'string' && EMAIL_RE.test(body.to) ? body.to : env.OWNER_EMAIL;
  if (!to) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'to' });

  const template =
    typeof body.template === 'string' && body.template in TEMPLATES ? body.template : 'system_test';

  const result = await notify(env, to, template, { time: new Date().toISOString() });
  if (!result.sent && !result.suppressed) {
    return fail(ERR.INTERNAL_ERROR, 'MAIL_SEND_FAILED', 502, { error: result.error });
  }
  return ok({ to, template, ...result });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const opt = handleOptions(request, env);
    if (opt) return opt;

    let resp: Response;
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      const m = request.method;

      if (p === '/api/tickets' && m === 'POST') {
        resp = await handleCreateTicket(request, env);
      } else if (p === '/api/tickets' && m === 'GET') {
        resp = await handleListTickets(request, env);
      } else if (p === '/api/tickets/apply-template' && m === 'GET') {
        resp = await handleTicketApplyTemplate(request, env);
      } else if (p === '/api/activities' && m === 'GET') {
        resp = await cachedGet(request, ctx, 30, () => handleActivityList(request, env)); // 游客列表边缘缓存 30s
      } else if (p === '/api/activities' && m === 'POST') {
        resp = await handleActivityCreate(request, env);
      } else if (m === 'DELETE' && /^\/api\/activities\/[^/]+$/.test(p)) {
        resp = await handleActivityDelete(request, env, p.split('/')[3]);
      } else if (m === 'GET' && /^\/api\/activities\/[^/]+\/qr$/.test(p)) {
        resp = await handleActivityQr(request, env, p.split('/')[3]);
      } else if (m === 'GET' && /^\/api\/activities\/me\/favorites$/.test(p)) {
        resp = await handleMyActivityFavorites(request, env);
      } else if (m === 'POST' && /^\/api\/activities\/[^/]+\/favorite$/.test(p)) {
        resp = await handleActivityFavoriteToggle(request, env, p.split('/')[3]);
      } else if (m === 'POST' && /^\/api\/activities\/[^/]+\/pin$/.test(p)) {
        resp = await handleActivityPin(request, env, p.split('/')[3]);
      } else if (m === 'DELETE' && /^\/api\/activities\/[^/]+\/pin$/.test(p)) {
        resp = await handleActivityUnpin(request, env, p.split('/')[3]);
      } else if (m === 'GET' && /^\/api\/activities\/[^/]+$/.test(p)) {
        resp = await handleActivityDetail(request, env, p.split('/')[3]);
      } else if (p === '/api/communities' && m === 'GET') {
        resp = await cachedGet(request, ctx, 30, () => handleCommunityList(request, env)); // 游客列表边缘缓存 30s
      } else if (p === '/api/communities' && m === 'POST') {
        resp = await handleCommunityCreate(request, env);
      } else if (m === 'DELETE' && /^\/api\/communities\/[^/]+$/.test(p)) {
        resp = await handleCommunityDelete(request, env, p.split('/')[3]);
      } else if (m === 'GET' && /^\/api\/tickets\/[^/]+$/.test(p)) {
        resp = await handleTicketDetail(request, env, p.split('/')[3]);
      } else if (m === 'POST' && /^\/api\/tickets\/[^/]+\/messages$/.test(p)) {
        resp = await handleTicketReply(request, env, p.split('/')[3]);
      } else if (m === 'POST' && /^\/api\/tickets\/[^/]+\/close$/.test(p)) {
        resp = await handleTicketClose(request, env, p.split('/')[3]);
      } else if (p === '/api/meta' && m === 'GET') {
        resp = await cachedGet(request, ctx, 300, () => handleMeta(env)); // 边缘缓存 300s（与浏览器缓存同策略）
      } else if (p === '/api/about/timeline' && m === 'GET') {
        resp = await cachedGet(request, ctx, 60, () => handleAboutTimeline(request, env)); // 站长改配置最多延迟 60s 生效
      } else if (p === '/api/about/thanks' && m === 'GET') {
        resp = await cachedGet(request, ctx, 60, () => handleAboutThanks(request, env)); // 鸣谢名单，60s
      } else if (p === '/api/about/links' && m === 'GET') {
        resp = await cachedGet(request, ctx, 60, () => handleAboutLinks(request, env)); // 友情链接，60s
      } else if (p === '/api/auth/email-policy' && m === 'GET') {
        resp = await cachedGet(request, ctx, 60, () => handleEmailPolicy(request, env)); // 邮箱域名白名单，60s
      } else if (p === '/api/notices' && m === 'GET') {
        resp = await cachedGet(request, ctx, 60, () => handleNotices(env)); // 边缘缓存 60s
      } else if (p === '/api/nav/links' && m === 'GET') {
        resp = await cachedGet(request, ctx, 60, () => handleNavLinks(request, env)); // 公开导航，60s
      } else if (p === '/api/nav/links' && m === 'POST') {
        resp = await handleNavSubmit(request, env);
      } else if (p === '/api/export/acts' && m === 'GET') {
        resp = await cachedGet(request, ctx, 300, () => handleExportActs(request, env)); // 采集端烘焙源，边缘缓存 300s
      } else if (p === '/api/export/chats' && m === 'GET') {
        resp = await cachedGet(request, ctx, 300, () => handleExportChats(request, env));
      } else if (p === '/api/export/navlinks' && m === 'GET') {
        resp = await cachedGet(request, ctx, 300, () => handleExportNavlinks(request, env));
      } else if (p === '/api/notifications' && m === 'GET') {
        resp = await handleNotificationsList(request, env); // 本人最近 50 条 + 未读数
      } else if (p === '/api/notifications/read' && m === 'POST') {
        resp = await handleNotificationsRead(request, env); // 单条/全部已读
      } else if (p === '/api/notifications/delete' && m === 'POST') {
        resp = await handleNotificationsDelete(request, env); // 单条删除
      } else if (p === '/api/notifications/clear-read' && m === 'POST') {
        resp = await handleNotificationsClearRead(request, env); // 清空已读
      } else if (p === '/api/mail/test' && m === 'POST') {
        resp = await handleMailTest(request, env);
      } else if (p === '/api/auth/send-code' && m === 'POST') {
        resp = await handleSendCode(request, env);
      } else if (p === '/api/auth/login-params' && m === 'POST') {
        resp = await handleLoginParams(request, env);
      } else if (p === '/api/auth/register' && m === 'POST') {
        resp = await handleRegister(request, env);
      } else if (p === '/api/auth/login' && m === 'POST') {
        resp = await handleLogin(request, env);
      } else if (p === '/api/auth/reset-password' && m === 'POST') {
        resp = await handleResetPassword(request, env);
      } else if (p === '/api/auth/logout' && m === 'POST') {
        resp = await handleLogout(request, env);
      } else if (p === '/api/auth/me' && m === 'GET') {
        resp = await handleMe(request, env);
      } else if (p === '/api/auth/nickname' && m === 'POST') {
        resp = await handleNickname(request, env);
      } else if (p === '/api/auth/profile' && m === 'POST') {
        resp = await handleSetProfile(request, env);
      } else if (p === '/api/auth/avatar' && m === 'POST') {
        resp = await handleSetMyAvatar(request, env);
      } else if (p.startsWith('/api/auth/avatar/') && m === 'GET') {
        resp = await handleAvatar(request, env, p.slice('/api/auth/avatar/'.length));
      } else if (p.startsWith('/api/auth/profile/') && m === 'GET') {
        resp = await handlePublicProfile(request, env, p.slice('/api/auth/profile/'.length));
      } else if (p.startsWith('/api/cardhub/')) {
        // 模块总开关：关闭则 /api/cardhub/* 全部 503（§4.1）
        const mg = await moduleGuard(env);
        if (mg) { resp = mg; } else if (p === '/api/cardhub/schema' && m === 'GET') {
          resp = await cachedGet(request, ctx, 300, () => handleSchema(request, env)); // 边缘缓存 300s
        } else if (p === '/api/cardhub/posts' && m === 'GET') {
          resp = await cachedGet(request, ctx, 30, () => handlePostsList(request, env)); // 游客列表边缘缓存 30s
        } else if (p === '/api/cardhub/board-counts' && m === 'GET') {
          resp = await cachedGet(request, ctx, 60, () => handleBoardCounts(request, env)); // 边缘缓存 60s
        } else if (p === '/api/cardhub/posts' && m === 'POST') {
          resp = await handleCreatePost(request, env);
        } else if (p === '/api/cardhub/me/posts' && m === 'GET') {
          resp = await handleMyPosts(request, env);
        } else if (p === '/api/cardhub/me/deals' && m === 'GET') {
          resp = await handleMyDeals(request, env);
        } else if (m === 'GET' && /^\/api\/cardhub\/posts\/[^/]+$/.test(p)) {
          resp = await handlePostDetail(request, env, p.slice('/api/cardhub/posts/'.length));
        } else if (m === 'PUT' && /^\/api\/cardhub\/posts\/[^/]+$/.test(p)) {
          resp = await handleUpdatePost(request, env, p.slice('/api/cardhub/posts/'.length));
        } else if (m === 'GET' && /^\/api\/cardhub\/posts\/[^/]+\/proof\/[^/]+$/.test(p)) {
          const seg = p.split('/');
          resp = await handleProofImage(request, env, seg[4], seg[6]);
        } else if (m === 'POST' && /^\/api\/cardhub\/posts\/[^/]+\/close$/.test(p)) {
          resp = await handleClosePost(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/cardhub\/posts\/[^/]+\/withdraw$/.test(p)) {
          resp = await handleWithdrawPost(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/cardhub\/posts\/[^/]+\/resubmit$/.test(p)) {
          resp = await handleResubmitPost(request, env, p.split('/')[4]);
        } else if (m === 'DELETE' && /^\/api\/cardhub\/posts\/[^/]+$/.test(p)) {
          resp = await handleDeletePost(request, env, p.slice('/api/cardhub/posts/'.length));
        } else if (p === '/api/cardhub/conversations' && m === 'POST') {
          resp = await handleCreateConversation(request, env);
        } else if (m === 'POST' && /^\/api\/cardhub\/dm\/[^/]+$/.test(p)) {
          resp = await handleDmCreate(request, env, p.split('/')[4]);
        } else if (p === '/api/cardhub/me/conversations' && m === 'GET') {
          resp = await handleMyConversations(request, env);
        } else if (m === 'GET' && /^\/api\/cardhub\/conversations\/[^/]+$/.test(p)) {
          resp = await handleConversationDetail(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/cardhub\/conversations\/[^/]+\/messages$/.test(p)) {
          resp = await handleReplyMessage(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/cardhub\/conversations\/[^/]+\/hide$/.test(p)) {
          resp = await handleConversationHide(request, env, p.split('/')[4]);
        } else if (p === '/api/cardhub/relay-requests' && m === 'POST') {
          resp = await handleCreateRelayRequest(request, env);
        } else if (p === '/api/cardhub/me/favorites' && m === 'GET') {
          resp = await handleMyFavorites(request, env);
        } else if (m === 'POST' && /^\/api\/cardhub\/posts\/[^/]+\/favorite$/.test(p)) {
          resp = await handleFavoriteToggle(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/cardhub\/posts\/[^/]+\/pin$/.test(p)) {
          resp = await handlePinPost(request, env, p.split('/')[4]);
        } else if (m === 'DELETE' && /^\/api\/cardhub\/posts\/[^/]+\/pin$/.test(p)) {
          resp = await handleUnpinPost(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/cardhub\/posts\/[^/]+\/pin\/bump$/.test(p)) {
          resp = await handlePinBump(request, env, p.split('/')[4]);
        } else {
          resp = fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
        }
      } else if (p.startsWith('/api/admin/')) {
        if (p === '/api/admin/conversations' && m === 'GET') {
          resp = await handleAdminConvList(request, env); // 站长专用：查任意用户参与的会话
        } else if (p === '/api/admin/nav' && m === 'GET') {
          resp = await handleNavAdminList(request, env);
        } else if (m === 'POST' && /^\/api\/admin\/nav\/[^/]+\/review$/.test(p)) {
          resp = await handleNavReview(request, env, p.split('/')[4]);
        } else if (m === 'PUT' && /^\/api\/admin\/nav\/[^/]+$/.test(p)) {
          resp = await handleNavUpdate(request, env, p.split('/')[4]);
        } else if (m === 'DELETE' && /^\/api\/admin\/nav\/[^/]+$/.test(p)) {
          resp = await handleNavDelete(request, env, p.split('/')[4]);
        } else if (p === '/api/admin/posts/pending' && m === 'GET') {
          resp = await handlePendingPosts(request, env);
        } else if (p === '/api/admin/posts' && m === 'GET') {
          resp = await handleListPosts(request, env);
        } else if (m === 'POST' && /^\/api\/admin\/posts\/[^/]+\/review$/.test(p)) {
          resp = await handleReviewPost(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/posts\/[^/]+\/close$/.test(p)) {
          resp = await handleAdminClosePost(request, env, p.split('/')[4]);
        } else if (m === 'GET' && /^\/api\/admin\/posts\/[^/]+$/.test(p)) {
          resp = await handleAdminPostDetail(request, env, p.split('/')[4]);
        } else if (m === 'DELETE' && /^\/api\/admin\/posts\/[^/]+$/.test(p)) {
          resp = await handleAdminDeletePost(request, env, p.split('/')[4]);
        } else if (p === '/api/admin/relay-requests' && m === 'GET') {
          resp = await handleListRelayRequests(request, env);
        } else if (m === 'POST' && /^\/api\/admin\/relay-requests\/[^/]+\/handle$/.test(p)) {
          resp = await handleRelayRequest(request, env, p.split('/')[4]);
        } else if (p === '/api/admin/users' && m === 'GET') {
          resp = await handleListUsers(request, env);
        } else if (m === 'GET' && /^\/api\/admin\/users\/[^/]+\/profile$/.test(p)) {
          resp = await handleGetUserProfile(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/users\/[^/]+\/profile$/.test(p)) {
          resp = await handleSetUserProfile(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/users\/[^/]+\/title$/.test(p)) {
          resp = await handleSetTitle(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/users\/[^/]+\/ban$/.test(p)) {
          resp = await handleBanUser(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/users\/[^/]+\/unban$/.test(p)) {
          resp = await handleUnbanUser(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/users\/[^/]+\/role$/.test(p)) {
          resp = await handleSetUserRole(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/users\/[^/]+\/avatar$/.test(p)) {
          resp = await handleSetAvatar(request, env, p.split('/')[4]);
        } else if (p === '/api/admin/settings' && m === 'GET') {
          resp = await handleGetSettings(request, env);
        } else if (m === 'PUT' && /^\/api\/admin\/settings\/[^/]+$/.test(p)) {
          resp = await handleUpdateSetting(request, env, p.slice('/api/admin/settings/'.length));
        } else if (p === '/api/admin/audit' && m === 'GET') {
          resp = await handleListAuditLogs(request, env);
        } else if (p === '/api/admin/activities' && m === 'GET') {
          resp = await handleAdminActivityList(request, env);
        } else if (m === 'GET' && /^\/api\/admin\/communities\/[^/]+\/proof$/.test(p)) {
          resp = await handleCommunityProof(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/activities\/[^/]+\/review$/.test(p)) {
          resp = await handleAdminActivityReview(request, env, p.split('/')[4]);
        } else if (m === 'POST' && /^\/api\/admin\/activities\/[^/]+\/retire$/.test(p)) {
          resp = await handleAdminActivityRetire(request, env, p.split('/')[4]);
        } else if (m === 'DELETE' && /^\/api\/admin\/activities\/[^/]+$/.test(p)) {
          resp = await handleAdminActivityDelete(request, env, p.split('/')[4]);
        } else if (p === '/api/admin/stats' && m === 'GET') {
          resp = await handleStats(request, env);
        } else {
          resp = fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
        }
      } else {
        resp = fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
      }
    } catch (e) {
      // 统一兜底 500：错误详情落实时日志（Cloudflare 后台 Real-time Logs 可查），提升线上 500 可归因性
      console.error('[worker] unhandled error:', e);
      resp = fail(ERR.INTERNAL_ERROR, 'INTERNAL_ERROR', 500);
    }
    return withCors(resp, request, env);
  },

  // Cron 日常保洁（§8/§16）：清理过期限流桶、过期 auth_codes、过期/吊销 sessions
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(Promise.all([
      env.DB.prepare('DELETE FROM rate_buckets WHERE reset_at < ?1').bind(now).run(),
      env.DB.prepare('DELETE FROM auth_codes WHERE expires_at < ?1').bind(now - 24 * 3600 * 1000).run(),
      env.DB.prepare('DELETE FROM sessions WHERE (expires_at < ?1 AND revoked_at IS NULL) OR (revoked_at < ?2)').bind(now, now - 30 * 86400 * 1000).run(),
      runCardhubCron(env),
      runActivitiesCron(env),
    ]));
  },
} satisfies ExportedHandler<Env>;
