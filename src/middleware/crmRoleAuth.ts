import { Request, Response, NextFunction } from 'express';
import { verifyCrmSessionToken } from '../utils/sessionToken';

export type SocialCrmRole = 'approver' | 'editor' | 'admin';

export interface AuthenticatedCrmUser {
  id: string;
  email: string;
  name: string;
  role: SocialCrmRole;
}

declare global {
  namespace Express {
    interface Request {
      crmUser?: AuthenticatedCrmUser;
    }
  }
}

function mapEmailAndRoleToCrmRole(email: string, rawRole: string): SocialCrmRole {
  const lowerEmail = (email || '').toLowerCase().trim();
  const lowerRole = (rawRole || '').toLowerCase().trim();

  const approverEnv = (process.env.EMAIL_APPROVER || 'asif@leadersperformance.ae')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const editorsEnv = (
    process.env.EMAIL_EDITORS ||
    'sharathkiranpr@gmail.com,mirza@leadersperformance.ae'
  )
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const adminEnv = (process.env.EMAIL_ADMIN || 'asif@leadersperformance.ae,mirza@leadersperformance.ae')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());

  if (lowerRole === 'approver' || lowerRole === 'founder' || approverEnv.includes(lowerEmail)) {
    return 'approver';
  }
  if (lowerRole === 'admin' || adminEnv.includes(lowerEmail)) {
    return 'admin';
  }
  if (
    lowerRole === 'editor' ||
    lowerRole === 'staff' ||
    lowerRole === 'content_manager' ||
    editorsEnv.includes(lowerEmail)
  ) {
    return 'editor';
  }
  return 'editor';
}

/**
 * Authenticates logged-in CRM users via Bearer session token (`lp_sess.*`)
 * and attaches `req.crmUser` with their role (`approver`, `editor`, or `admin`).
 */
export function requireCrmAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader;

  if (bearerToken) {
    const verified = verifyCrmSessionToken(bearerToken);
    if (verified) {
      req.crmUser = {
        id: verified.id,
        email: verified.email,
        name: verified.name || verified.email.split('@')[0],
        role: mapEmailAndRoleToCrmRole(verified.email, verified.role),
      };
      next();
      return;
    }
  }

  res.status(401).json({
    success: false,
    code: 'UNAUTHORIZED',
    error: 'Valid CRM session token is required.',
  });
}

/**
 * Role guard enforcing Plan Section 1 & 7 role permissions:
 * - Mr. Lionel (approver): approve, request changes, reject, comment, publish-now
 * - Sarath & Asad (editor): edit post, replace media, resubmit, fix blocked posts, comment, manual-done
 * - Asif (admin): everything
 */
export function requireCrmRoles(...allowedRoles: SocialCrmRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.crmUser) {
      res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        error: 'Authentication required.',
      });
      return;
    }

    // Admin (Asif) can perform all actions per Plan Section 1 ("Everything + connect accounts, retry/replay, settings")
    if (req.crmUser.role === 'admin' || allowedRoles.includes(req.crmUser.role)) {
      next();
      return;
    }

    res.status(403).json({
      success: false,
      code: 'FORBIDDEN_ROLE',
      error: `Role "${req.crmUser.role}" is not permitted to perform this action. Allowed: ${allowedRoles.join(', ')}.`,
    });
  };
}

