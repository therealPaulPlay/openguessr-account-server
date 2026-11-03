import proxyaddr from 'proxy-addr';
import { trustedProxiesCount } from './config.js';

export const getClientIp = (req) => proxyaddr(req, (_addr, i) => i < trustedProxiesCount);