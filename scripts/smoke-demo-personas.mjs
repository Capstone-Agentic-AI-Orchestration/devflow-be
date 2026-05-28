import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(path = resolve(process.cwd(), '.env')) {
  let content = '';

  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

function assertCheck(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

loadEnvFile();

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const apiUrl = (process.env.DEMO_API_URL ?? process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const projectId = process.env.DEMO_PROJECT_ID ?? 'demo-persona-project';
const password = process.env.DEMO_AUTH_PASSWORD ?? 'DevFlowDemo123!';
const personas = {
  PM: process.env.DEMO_PM_EMAIL ?? 'devflow.pm@example.com',
  DEV: process.env.DEMO_DEV_EMAIL ?? 'devflow.dev@example.com',
  CLIENT: process.env.DEMO_CLIENT_EMAIL ?? 'devflow.client@example.com',
};

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required for npm run seed:demo:smoke.');
  process.exit(1);
}

async function signIn(email) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Failed to sign in ${email}: ${payload.msg || payload.message || response.statusText}`);
  }

  return payload.access_token;
}

async function apiRequest(path, token, expectedStatus = 200, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  assertCheck(
    response.status === expectedStatus,
    `${path} expected ${expectedStatus}, got ${response.status}: ${text}`,
  );
  return body;
}

async function apiGet(path, token, expectedStatus = 200) {
  return apiRequest(path, token, expectedStatus);
}

async function apiPost(path, token, body, expectedStatus = 201) {
  return apiRequest(path, token, expectedStatus, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function apiPublicPost(path, body, expectedStatus = 201) {
  return apiRequest(path, null, expectedStatus, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function apiPatch(path, token, body = {}, expectedStatus = 200) {
  return apiRequest(path, token, expectedStatus, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

async function apiDelete(path, token, expectedStatus = 200) {
  return apiRequest(path, token, expectedStatus, {
    method: 'DELETE',
  });
}

function includesProject(projects) {
  return Array.isArray(projects) && projects.some((project) => project.id === projectId);
}

function workOrderAgentTypeFromArtifact(artifact) {
  const normalized = String(artifact?.agentType ?? '').toUpperCase();
  return ['FRONTEND', 'BACKEND', 'DATABASE', 'ARCHITECTURE', 'CONTRACT'].includes(normalized)
    ? normalized
    : 'FRONTEND';
}

async function smoke() {
  const pmToken = await signIn(personas.PM);
  const devToken = await signIn(personas.DEV);
  const clientToken = await signIn(personas.CLIENT);

  const pmMe = await apiGet('/auth/me', pmToken);
  const devMe = await apiGet('/auth/me', devToken);
  const clientMe = await apiGet('/auth/me', clientToken);

  assertCheck(pmMe.role === 'PM', `Expected PM auth role, got ${pmMe.role}.`);
  assertCheck(devMe.role === 'DEV', `Expected DEV auth role, got ${devMe.role}.`);
  assertCheck(clientMe.role === 'CLIENT', `Expected CLIENT auth role, got ${clientMe.role}.`);

  const pmProjects = await apiGet('/projects', pmToken);
  const devProjects = await apiGet('/projects', devToken);
  const clientProjects = await apiGet('/projects', clientToken);

  assertCheck(includesProject(pmProjects), 'PM project list should include the demo project.');
  assertCheck(includesProject(devProjects), 'DEV project list should include the demo project.');
  assertCheck(includesProject(clientProjects), 'CLIENT project list should include the demo project.');
  const pmProjectSummary = pmProjects.find((project) => project.id === projectId);
  assertCheck(pmProjectSummary?.lifecycle?.stage === 'REVISION', `PM project summary should derive REVISION lifecycle, got ${pmProjectSummary?.lifecycle?.stage}.`);
  assertCheck(pmProjectSummary?.lifecycle?.nextAction === 'Resolve revision', 'PM project summary should expose the revision next action.');

  const pmArtifacts = await apiGet(`/projects/${projectId}/artifacts`, pmToken);
  const devTasks = await apiGet(`/projects/${projectId}/tasks`, devToken);
  const devWorkOrders = await apiGet(`/projects/${projectId}/work-orders`, devToken);
  const clientArtifacts = await apiGet(`/projects/${projectId}/artifacts`, clientToken);
  const clientTimeline = await apiGet(`/projects/${projectId}/timeline`, clientToken);
  const pmConversations = await apiGet(`/projects/${projectId}/conversations`, pmToken);
  const devConversations = await apiGet(`/projects/${projectId}/conversations`, devToken);
  const clientConversations = await apiGet(`/projects/${projectId}/conversations`, clientToken);
  const pmDocuments = await apiGet(`/projects/${projectId}/documents`, pmToken);
  const clientDocuments = await apiGet(`/projects/${projectId}/documents`, clientToken);
  const clientInvites = await apiGet('/client-invites/me', clientToken);
  const pmProjectDetail = await apiGet(`/projects/${projectId}`, pmToken);
  const deliveryReview = await apiGet(`/projects/${projectId}/delivery-review`, pmToken);
  const kickoff = await apiGet(`/projects/${projectId}/kickoff`, pmToken);

  assertCheck(pmArtifacts.length === 3, `PM should see 3 artifacts, saw ${pmArtifacts.length}.`);
  assertCheck(devTasks.length === 2, `DEV should see 2 assigned tasks, saw ${devTasks.length}.`);
  assertCheck(devWorkOrders.length === 2, `DEV should see 2 assigned work orders, saw ${devWorkOrders.length}.`);
  assertCheck(clientArtifacts.length === 2, `CLIENT should see 2 client-visible artifacts, saw ${clientArtifacts.length}.`);
  assertCheck(clientTimeline.every((event) => event.visibility === 'CLIENT'), 'CLIENT timeline should contain only client-visible events.');
  assertCheck(pmConversations.length === 2, `PM should see 2 collaboration conversations, saw ${pmConversations.length}.`);
  assertCheck(devConversations.every((conversation) => conversation.visibility === 'TEAM'), 'DEV should see only team conversations.');
  assertCheck(clientConversations.every((conversation) => conversation.visibility === 'CLIENT'), 'CLIENT should see only client-visible conversations.');
  assertCheck(pmDocuments.length === 3, `PM should see 3 collaboration documents, saw ${pmDocuments.length}.`);
  assertCheck(clientDocuments.length === 2, `CLIENT should see 2 client-visible documents, saw ${clientDocuments.length}.`);
  assertCheck(clientInvites.some((invite) => invite.projectId === projectId && invite.status === 'ACCEPTED'), 'CLIENT should have an accepted invite for the demo project.');
  assertCheck(pmProjectDetail.kickoff?.status === 'READY', 'PM project detail should include a ready kickoff.');
  assertCheck(pmProjectDetail.deliveryReview?.status === 'REVISION_REQUESTED', `PM project detail should include a delivery revision, got ${pmProjectDetail.deliveryReview?.status}.`);
  assertCheck(deliveryReview?.status === 'REVISION_REQUESTED', `Delivery review endpoint should return REVISION_REQUESTED, got ${deliveryReview?.status}.`);
  assertCheck(pmProjectDetail.lifecycle?.stage === 'REVISION', `PM project detail should derive REVISION lifecycle, got ${pmProjectDetail.lifecycle?.stage}.`);
  assertCheck(kickoff.status === 'READY', `Expected kickoff status READY, got ${kickoff.status}.`);
  await apiPost('/client-invites/accept', clientToken, {}, 201);
  await apiPost(`/projects/${projectId}/delivery-review/accept`, clientToken, {
    note: 'Smoke test final acceptance should be blocked while reviews are open.',
  }, 400);

  const dispatchableWorkOrder = devWorkOrders.find((workOrder) => workOrder.status === 'READY') ?? devWorkOrders[0];
  assertCheck(dispatchableWorkOrder, 'DEV should have a dispatchable work order for bridge smoke coverage.');
  const executedWorkOrder = await apiPost(`/projects/${projectId}/work-orders/${dispatchableWorkOrder.id}/dispatch`, pmToken, {}, 202);
  assertCheck(executedWorkOrder.status === 'COMPLETED', `Dispatched work order should complete through the bridge, got ${executedWorkOrder.status}.`);
  assertCheck(Boolean(executedWorkOrder.executionRunId), 'Executed work order should include an execution run id.');
  assertCheck(Boolean(executedWorkOrder.artifactId), 'Executed work order should link to a generated artifact.');
  const postDispatchArtifacts = await apiGet(`/projects/${projectId}/artifacts`, pmToken);
  const postDispatchEvents = await apiGet(`/projects/${projectId}/events`, pmToken);
  assertCheck(postDispatchArtifacts.some((artifact) => artifact.id === executedWorkOrder.artifactId), 'Generated work-order artifact should be visible to PM artifacts.');
  assertCheck(postDispatchEvents.some((event) => event.eventType === 'COMPLETED' && event.costMeta?.workOrderId === dispatchableWorkOrder.id), 'Work-order execution should record a COMPLETED event log.');

  await apiPost(`/projects/${projectId}/work-orders/${dispatchableWorkOrder.id}/dispatch`, devToken, {}, 403);

  const publishedOutput = await apiPost(`/projects/${projectId}/artifacts/${executedWorkOrder.artifactId}/publish`, pmToken, {
    displayName: 'Smoke published work-order output',
  }, 200);
  assertCheck(publishedOutput.clientVisible === true, 'Published work-order output should become client-visible.');
  assertCheck(publishedOutput.outputReviewStatus === 'PUBLISHED', `Published output should have PUBLISHED output status, got ${publishedOutput.outputReviewStatus}.`);
  const clientArtifactsAfterPublish = await apiGet(`/projects/${projectId}/artifacts`, clientToken);
  assertCheck(clientArtifactsAfterPublish.some((artifact) => artifact.id === publishedOutput.id), 'CLIENT should see the PM-published work-order output.');
  await apiGet(`/projects/${projectId}/artifacts/${publishedOutput.id}`, clientToken, 403);
  await apiPatch(`/projects/${projectId}/artifacts/${publishedOutput.id}/output-review`, devToken, {
    status: 'APPROVED',
  }, 403);
  await apiPost(`/projects/${projectId}/artifacts/${publishedOutput.id}/publish`, devToken, {}, 403);
  await apiPost(`/projects/${projectId}/artifacts/${publishedOutput.id}/publish`, clientToken, {}, 403);
  await apiPost(`/projects/${projectId}/artifacts/${publishedOutput.id}/review`, pmToken, {
    reviewStatus: 'APPROVED',
  }, 403);
  const clientRevision = await apiPost(`/projects/${projectId}/artifacts/${publishedOutput.id}/review`, clientToken, {
    reviewStatus: 'REVISION_REQUESTED',
    reviewNote: 'Smoke test client revision on published output.',
  });
  assertCheck(clientRevision.reviewStatus === 'REVISION_REQUESTED', 'CLIENT should be able to request revision on the published output.');
  const revisionTask = await apiPost(`/projects/${projectId}/tasks`, pmToken, {
    title: 'Smoke revision task from client output review',
    description: clientRevision.reviewNote,
    assignedToId: devMe.id,
    artifactId: publishedOutput.id,
  });
  assertCheck(revisionTask.artifactId === publishedOutput.id, 'PM-created revision task should stay linked to the revised artifact.');
  assertCheck(revisionTask.assignedToId === devMe.id, 'PM-created revision task should be assigned to the DEV persona.');
  const revisionWorkOrder = await apiPost(`/projects/${projectId}/work-orders`, pmToken, {
    title: 'Smoke revision handoff',
    instructions: `Client revision request:\n${clientRevision.reviewNote}`,
    agentType: workOrderAgentTypeFromArtifact(publishedOutput),
    priority: 'HIGH',
    taskId: revisionTask.id,
    artifactId: publishedOutput.id,
  });
  const readyRevisionWorkOrder = await apiPatch(`/projects/${projectId}/work-orders/${revisionWorkOrder.id}`, pmToken, {
    status: 'READY',
  });
  assertCheck(readyRevisionWorkOrder.status === 'READY', 'PM should be able to mark revision work order READY.');
  const devRevisionWorkOrders = await apiGet(`/projects/${projectId}/work-orders`, devToken);
  assertCheck(devRevisionWorkOrders.some((workOrder) => workOrder.id === readyRevisionWorkOrder.id), 'DEV should see the revision work order assigned through the revision task.');
  const executedRevisionWorkOrder = await apiPost(`/projects/${projectId}/work-orders/${readyRevisionWorkOrder.id}/dispatch`, pmToken, {}, 202);
  assertCheck(executedRevisionWorkOrder.status === 'COMPLETED', `Revision work order should complete through mock agents, got ${executedRevisionWorkOrder.status}.`);
  assertCheck(Boolean(executedRevisionWorkOrder.artifactId), 'Revision work order should produce a revised artifact.');
  const revisedOutput = await apiPost(`/projects/${projectId}/artifacts/${executedRevisionWorkOrder.artifactId}/publish`, pmToken, {
    displayName: 'Smoke revised published output',
  }, 200);
  assertCheck(revisedOutput.clientVisible === true, 'PM should be able to publish the revised generated output.');
  const clientApprovedRevision = await apiPost(`/projects/${projectId}/artifacts/${revisedOutput.id}/review`, clientToken, {
    reviewStatus: 'APPROVED',
    reviewNote: 'Smoke test client approval on revised output.',
  });
  assertCheck(clientApprovedRevision.reviewStatus === 'APPROVED', 'CLIENT should be able to approve the revised published output.');
  const handledRevision = await apiPatch(`/projects/${projectId}/artifacts/${publishedOutput.id}/revision`, pmToken, {
    resolutionNote: 'Smoke test PM routed the revision into DEV work and published a revised output.',
  });
  assertCheck(Boolean(handledRevision.revisionHandledAt), 'PM should be able to handle the client revision on the published output.');
  const pmTimelineAfterRevision = await apiGet(`/projects/${projectId}/timeline`, pmToken);
  assertCheck(pmTimelineAfterRevision.some((event) => event.type === 'WORK_ORDER_CREATED' && event.artifactId === publishedOutput.id), 'PM timeline should include the revision work order creation.');
  assertCheck(pmTimelineAfterRevision.some((event) => event.type === 'ARTIFACT_PUBLISHED' && event.artifactId === revisedOutput.id), 'PM timeline should include the revised output publication.');
  assertCheck(pmTimelineAfterRevision.some((event) => event.type === 'REVISION_HANDLED' && event.artifactId === publishedOutput.id), 'PM timeline should include revision handling.');
  const pmNotificationsAfterRevision = await apiGet('/notifications', pmToken);
  assertCheck(pmNotificationsAfterRevision.some((notification) => notification.type === 'ARTIFACT_REVIEWED' && notification.artifactId === publishedOutput.id), 'PM notifications should include the client revision review.');

  const clientThread = clientConversations[0];
  assertCheck(clientThread, 'CLIENT should have a client-visible conversation.');
  const clientMessages = await apiGet(`/projects/${projectId}/conversations/${clientThread.id}/messages`, clientToken);
  assertCheck(clientMessages.every((message) => message.conversationId === clientThread.id), 'Messages should be scoped to the selected conversation.');
  await apiPost(`/projects/${projectId}/conversations/${clientThread.id}/messages`, clientToken, {
    body: 'Smoke test client collaboration reply.',
  });
  await apiPatch(`/projects/${projectId}/conversations/${clientThread.id}/read`, clientToken);
  await apiPost(`/projects/${projectId}/conversations`, clientToken, {
    title: 'Blocked internal client thread',
    visibility: 'TEAM',
  }, 400);

  const reviewableDocument = clientDocuments.find((document) => document.status === 'APPROVAL_REQUESTED') ?? clientDocuments[0];
  assertCheck(reviewableDocument, 'CLIENT should have a reviewable collaboration document.');
  await apiPost(`/projects/${projectId}/documents/${reviewableDocument.id}/review`, clientToken, {
    status: 'APPROVED',
    reviewNote: 'Smoke test approval.',
  });
  const clientVisibleDocument = await apiPost(`/projects/${projectId}/documents`, pmToken, {
    title: 'Smoke client-visible approval document',
    clientVisible: true,
    status: 'APPROVED',
  });
  assertCheck(clientVisibleDocument.status === 'APPROVAL_REQUESTED', `Client-visible PM document should require approval, got ${clientVisibleDocument.status}.`);

  await apiGet(`/projects/${projectId}/tasks`, clientToken, 403);
  await apiGet(`/projects/${projectId}/work-orders`, clientToken, 403);
  await apiGet(`/projects/${projectId}/events`, clientToken, 403);
  await apiGet('/profiles?roles=DEV', clientToken, 403);
  await apiGet('/auth/me', null, 401);
  await apiGet('/projects', null, 401);
  await apiGet('/client-invites/me', pmToken, 403);
  await apiPost('/client-invites/accept', pmToken, {}, 403);
  await apiGet(`/projects/${projectId}/kickoff`, clientToken, 403);
  await apiPatch(`/projects/${projectId}/kickoff`, clientToken, {
    readinessNotes: 'Clients should not update kickoff.',
  }, 403);
  await apiPost(`/projects/${projectId}/delivery-review/accept`, pmToken, {
    note: 'PM users should not accept delivery for the client.',
  }, 403);
  await apiPost(`/projects/${projectId}/delivery-review/accept`, devToken, {
    note: 'DEV users should not accept delivery for the client.',
  }, 403);
  await apiPost(`/projects/${projectId}/delivery-review/revision`, pmToken, {
    note: 'PM users should not request client delivery revisions.',
  }, 403);
  await apiPatch(`/projects/${projectId}/delivery-review/resolve`, clientToken, {
    resolutionNote: 'Clients should not resolve delivery revisions.',
  }, 403);
  await apiPost(`/projects/${projectId}/members`, clientToken, {
    userId: devMe.id,
    role: 'DEV',
  }, 403);
  await apiPatch(`/projects/${projectId}/work-orders/${dispatchableWorkOrder.id}`, devToken, {
    status: 'READY',
  }, 403);
  await apiGet('/profiles?roles=DEV', pmToken);
  await apiPost(`/projects/${projectId}/members`, pmToken, {
    userId: clientMe.id,
    role: 'DEV',
  }, 400);
  await apiDelete(`/projects/${projectId}/members/${pmMe.id}`, pmToken, 400);
  await apiPost(`/projects/${projectId}/work-orders`, pmToken, {
    title: 'Blocked empty handoff',
    agentType: 'FRONTEND',
  }, 400);
  await apiPost('/projects', devToken, {
    companyName: 'Blocked Developer Project',
    brief: 'Developers should not create projects directly.',
    stackKey: 'nextjs-nestjs-supabase',
  }, 403);

  const submittedInquiry = await apiPublicPost('/inquiries', {
    companyName: 'Smoke Inquiry Co',
    contactName: 'Sam Smoke',
    email: `smoke-${Date.now()}@example.com`,
    brief: 'Smoke test inquiry submitted through the public client intake API.',
    stackKey: 'nextjs-nestjs-supabase',
  });
  assertCheck(submittedInquiry.status === 'NEW', `Expected submitted inquiry status NEW, got ${submittedInquiry.status}.`);
  const submittedInviteStatus = await apiGet(`/client-invites/status?email=${encodeURIComponent(submittedInquiry.email)}`, null);
  assertCheck(submittedInviteStatus.pending === 0, 'Unapproved inquiry should not have a pending client invite.');
  await apiPost(`/inquiries/${submittedInquiry.id}/approve`, devToken, {
    reviewNote: 'Developers should not approve inquiries.',
  }, 403);
  const approvedInquiry = await apiPost(`/inquiries/${submittedInquiry.id}/approve`, pmToken, {
    reviewNote: 'Smoke approval creates project and invite.',
  }, 200);
  assertCheck(approvedInquiry.status === 'APPROVED', `Expected approved inquiry status APPROVED, got ${approvedInquiry.status}.`);
  assertCheck(Boolean(approvedInquiry.approvedProjectId), 'Approved inquiry should expose approvedProjectId.');
  const approvedInviteStatus = await apiGet(`/client-invites/status?email=${encodeURIComponent(submittedInquiry.email)}`, null);
  assertCheck(approvedInviteStatus.pending === 1, 'Approved inquiry should create one pending client invite for new emails.');
  const pmInquiries = await apiGet('/inquiries', pmToken);
  assertCheck(pmInquiries.some((inquiry) => inquiry.id === submittedInquiry.id), 'PM inquiry list should include the submitted public inquiry.');
  await apiGet('/inquiries', devToken, 403);

  console.log('Demo persona API smoke checks passed.');
  console.table([
    { persona: 'PM', projects: pmProjects.length, artifacts: pmArtifacts.length, conversations: pmConversations.length, documents: pmDocuments.length, lifecycle: pmProjectSummary.lifecycle.stage, kickoff: kickoff.status, inquiries: pmInquiries.length },
    { persona: 'DEV', projects: devProjects.length, tasks: devTasks.length, workOrders: devWorkOrders.length },
    { persona: 'CLIENT', projects: clientProjects.length, artifacts: clientArtifacts.length, timeline: clientTimeline.length, conversations: clientConversations.length, documents: clientDocuments.length },
  ]);
}

try {
  await smoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
