import { loadDashboardState, changeDashboardState } from './dashboard-state.mjs';
import { withInboxLock } from './inbox-lock.mjs';
import { notifyCoordinatorRequest } from '../coordinator-bridge.mjs';

// Keep the target and send intent durable before the external effect. After a
// crash, only reconcile that same inbox; absence is not proof of non-delivery.
export function deliverCoordinatorNotice(root, requestId, notify = notifyCoordinatorRequest) {
  return withInboxLock(root, `notice:${requestId}`, async () => {
    const request = (await loadDashboardState(root)).coordinatorRequests.find(item => item.id === requestId);
    if (!request) throw new Error('No encuentro esa solicitud del coordinador.');
    if (['routed', 'withdrawn', 'answered'].includes(request.status) || request.notification?.status === 'sent') return request;
    let notification;
    try {
      notification = await notify(request, {
        cwd: root,
        beforeSend: async target => changeDashboardState(root, state => {
          const current = state.coordinatorRequests.find(item => item.id === requestId);
          current.notification = { status: 'sending', ...target, updatedAt: new Date().toISOString() };
        }),
      });
    } catch (error) {
      const current = (await loadDashboardState(root)).coordinatorRequests.find(item => item.id === requestId);
      const uncertain = ['sending', 'unknown'].includes(current.notification?.status);
      notification = { ...current.notification, status: uncertain ? 'unknown' : 'pending', requestId, uncertain, stage: current.notification?.status === 'sending' ? 'persist-send-intent' : 'notification', code: /^[a-z][a-z0-9_]{2,80}$/.test(error.code || '') ? error.code : 'coordinator_notice_unavailable', reason: 'No se confirmó el aviso; conserva esta solicitud y revisa su estado.' };
    }
    return changeDashboardState(root, state => {
      const current = state.coordinatorRequests.find(item => item.id === requestId);
      if (!['routed', 'withdrawn', 'answered'].includes(current.status)) {
        current.notification = { ...current.notification, ...notification, updatedAt: new Date().toISOString() };
        current.updatedAt = new Date().toISOString();
      }
      return current;
    });
  });
}
