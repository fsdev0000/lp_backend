import { Request, Response } from 'express';
import { crmUsersService, resolveCrmOrigin } from '../services/crmUsers.service';

function handleUsersError(res: Response, err: any, fallbackMessage: string): void {
  const statusCode = Number(err?.statusCode) || 500;
  res.status(statusCode).json({
    success: false,
    code: err?.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'USER_MANAGEMENT_ERROR'),
    error: err?.message || fallbackMessage,
  });
}

export class CrmUsersController {
  public listUsers = async (_req: Request, res: Response): Promise<void> => {
    try {
      const users = await crmUsersService.listUsers();
      res.status(200).json({
        success: true,
        data: users,
      });
    } catch (err) {
      handleUsersError(res, err, 'Failed to list CRM users');
    }
  };

  public inviteUser = async (req: Request, res: Response): Promise<void> => {
    try {
      const origin = resolveCrmOrigin(req.get('origin') || req.get('referer'));
      const created = await crmUsersService.inviteUser(
        req.crmUser!,
        {
          email: req.body?.email,
          name: req.body?.name,
          role: req.body?.role,
          workspaces: req.body?.workspaces,
        },
        origin,
        req.ip
      );
      res.status(200).json({
        success: true,
        data: created,
      });
    } catch (err) {
      handleUsersError(res, err, 'Failed to invite user');
    }
  };

  public updateUserAccess = async (req: Request, res: Response): Promise<void> => {
    try {
      const targetId = String(req.params.id || '').trim();
      const updated = await crmUsersService.updateUserAccess(
        req.crmUser!,
        targetId,
        {
          role: req.body?.role,
          workspaces: req.body?.workspaces,
        },
        req.ip
      );
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleUsersError(res, err, 'Failed to update user access');
    }
  };

  public deactivateUser = async (req: Request, res: Response): Promise<void> => {
    try {
      const targetId = String(req.params.id || '').trim();
      const updated = await crmUsersService.deactivateUser(req.crmUser!, targetId, req.ip);
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleUsersError(res, err, 'Failed to deactivate user');
    }
  };

  public reactivateUser = async (req: Request, res: Response): Promise<void> => {
    try {
      const targetId = String(req.params.id || '').trim();
      const updated = await crmUsersService.reactivateUser(req.crmUser!, targetId, req.ip);
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleUsersError(res, err, 'Failed to reactivate user');
    }
  };

  public resendInvite = async (req: Request, res: Response): Promise<void> => {
    try {
      const targetId = String(req.params.id || '').trim();
      const origin = resolveCrmOrigin(req.get('origin') || req.get('referer'));
      const updated = await crmUsersService.resendInvite(req.crmUser!, targetId, origin, req.ip);
      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err) {
      handleUsersError(res, err, 'Failed to resend invitation');
    }
  };
}

export const crmUsersController = new CrmUsersController();
