import { workDetailUrl, workScope } from './progress-work-model.js';
const scope = workScope(location.search);
scope.view = location.pathname.includes('queue') ? 'tasks' : 'wire';
const destination = new URL(workDetailUrl(scope), location.origin);
for (const [key,value] of new URLSearchParams(location.search)) if (!destination.searchParams.has(key)) destination.searchParams.append(key,value);
destination.hash = location.hash;
document.getElementById('legacyProgressLink').href = destination.href;
location.replace(destination.href);
