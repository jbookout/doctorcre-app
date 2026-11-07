import { startEarlyMailPriorities, readMailPriorities } from './mail-priorities-client';

if (location.pathname === '/') startEarlyMailPriorities(signal => readMailPriorities(signal, 'low'));
