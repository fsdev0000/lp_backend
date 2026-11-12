import { Request, Response } from 'express';
import { notificationSettingsService } from '../notifications/settings.service';
import { reminderService } from '../notifications/reminder.service';

export class NotificationSettingsController {
  public getSettings = async (req: Request, res: Response): Promise<void> => {
    try {
      const settings = await notificationSettingsService.getSettings();
      res.status(200).json({
        success: true,
        data: settings,
      });
    } catch (error: any) {
      console.error('[NotificationSettingsController] getSettings error:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to retrieve notification settings',
      });
    }
  };

  public updateSettings = async (req: Request, res: Response): Promise<void> => {
    try {
      const patch = req.body || {};
      const updated = await notificationSettingsService.updateSettings(patch);
      res.status(200).json({
        success: true,
        message: 'Notification settings updated successfully',
        data: updated,
      });
    } catch (error: any) {
      console.error('[NotificationSettingsController] updateSettings error:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to update notification settings',
      });
    }
  };

  public processReminders = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await reminderService.processPendingReminders();
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error('[NotificationSettingsController] processReminders error:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to process pending reminders',
      });
    }
  };

  public getReminderStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const postId = (req.params.id || req.query.postId) as string;
      if (!postId) {
        res.status(400).json({
          success: false,
          error: 'Missing required parameter: postId (as query param or route param)',
        });
        return;
      }
      const reminders = await reminderService.getReminderStatusForPost(postId);
      res.status(200).json({
        success: true,
        data: reminders,
      });
    } catch (error: any) {
      console.error('[NotificationSettingsController] getReminderStatus error:', error);
      res.status(500).json({
        success: false,
        error: error?.message || 'Failed to fetch reminder status',
      });
    }
  };
}

export const notificationSettingsController = new NotificationSettingsController();
