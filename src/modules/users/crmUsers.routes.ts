import { Router } from 'express';
import { requireCrmAuth, requireCrmRoles } from '../../middleware/crmRoleAuth';
import { crmUsersController } from './controllers/crmUsers.controller';

export const crmUsersRouter = Router();

// All User Management endpoints require a valid signed-in CRM user with super_admin or admin role
crmUsersRouter.use(requireCrmAuth);
crmUsersRouter.use(requireCrmRoles('super_admin', 'admin'));

crmUsersRouter.get('/', crmUsersController.listUsers);
crmUsersRouter.post('/invite', crmUsersController.inviteUser);
crmUsersRouter.patch('/:id', crmUsersController.updateUserAccess);
crmUsersRouter.post('/:id/deactivate', crmUsersController.deactivateUser);
crmUsersRouter.post('/:id/reactivate', crmUsersController.reactivateUser);
crmUsersRouter.post('/:id/resend-invite', crmUsersController.resendInvite);

export default crmUsersRouter;
