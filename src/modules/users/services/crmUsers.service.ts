import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  getSupabaseClient,
  getSupabaseUrl,
  getSupabaseServiceKey,
} from '../../../services/supabaseStorageService';
import {
  ALL_WORKSPACES,
  AuthenticatedCrmUser,
  CanonicalCrmRole,
  cleanWorkspacesForRole,
  isSupabaseUserDeactivated,
  mapEmailAndRoleToCrmRole,
  setLiveUserOverride,
  VerifiedSupabaseUser,
} from '../../../middleware/crmRoleAuth';
import {
  generateCrmSessionToken,
  restoreUserSessions,
  revokeUserSessions,
} from '../../../utils/sessionToken';
import { contentPrisma } from '../../content/services/content.service';
import { sendSmtpEmail } from '../../automation/notifications/smtpDispatcher';

export type CrmUserStatus = 'active' | 'invited' | 'deactivated';

export interface CrmManagedUser {
  id: string;
  email: string;
  name: string;
  role: CanonicalCrmRole;
  workspaces: string[];
  status: CrmUserStatus;
  lastSignInAt: string | null;
  invitedAt: string | null;
  createdAt: string;
}

const VALID_ROLES: CanonicalCrmRole[] = ['super_admin', 'admin', 'manager', 'user'];
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Single-use password link token hashes so a used link cannot set a password a second time. */
const usedPasswordTokenHashes = new Set<string>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createCrmHttpError(
  statusCode: number,
  message: string,
  code?: string
): Error & { statusCode: number; code?: string } {
  const err = new Error(message) as Error & { statusCode: number; code?: string };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

export function resolveCrmOrigin(originHeader?: string): string {
  if (
    originHeader &&
    (originHeader.includes('leadersperformance.ae') || originHeader.includes('localhost'))
  ) {
    return originHeader.replace(/\/$/, '');
  }
  return (process.env.CRM_BASE_URL || 'https://social.leadersperformance.ae').replace(/\/$/, '');
}

export class CrmUsersService {
  /**
   * Maps a raw Supabase Auth user record into the CrmManagedUser contract.
   */
  public toManagedUser(u: VerifiedSupabaseUser): CrmManagedUser {
    const email = (u.email || '').trim().toLowerCase();
    const rawRole = String(u.app_metadata?.role || 'user');
    const roleVersion = u.app_metadata?.roleVersion;
    const role = mapEmailAndRoleToCrmRole(email, rawRole, roleVersion);
    const hasExplicitWorkspaces = Array.isArray(u.app_metadata?.workspaces);
    const workspaces = cleanWorkspacesForRole(
      role,
      u.app_metadata?.workspaces,
      !hasExplicitWorkspaces && roleVersion !== 2
    );

    const name =
      (u.app_metadata?.name as string) ||
      (u.user_metadata?.full_name as string) ||
      (u.user_metadata?.name as string) ||
      (u.user_metadata?.display_name as string) ||
      (email ? email.split('@')[0] : 'CRM User');

    let status: CrmUserStatus = 'active';
    if (isSupabaseUserDeactivated(u)) {
      status = 'deactivated';
    } else if (
      u.app_metadata?.status === 'invited' ||
      (!u.last_sign_in_at && u.invited_at && !u.app_metadata?.password_set)
    ) {
      status = 'invited';
    }

    const lastSignInAt = u.last_sign_in_at || null;
    const invitedAt = (u.app_metadata?.invitedAt as string) || u.invited_at || null;
    const createdAt = u.created_at || new Date().toISOString();

    const managed: CrmManagedUser = {
      id: u.id,
      email,
      name,
      role,
      workspaces,
      status,
      lastSignInAt,
      invitedAt,
      createdAt,
    };

    // Keep live override synchronized
    setLiveUserOverride({
      id: managed.id,
      email: managed.email,
      name: managed.name,
      role: managed.role,
      workspaces: managed.workspaces,
      status: managed.status,
    });

    return managed;
  }

  /**
   * Lists all CRM users across all Supabase Auth pages.
   */
  public async listUsers(): Promise<CrmManagedUser[]> {
    const supabase = await getSupabaseClient();
    const allRawUsers: VerifiedSupabaseUser[] = [];
    let page = 1;
    const perPage = 200;

    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        throw createCrmHttpError(500, `Failed to list users: ${error.message}`);
      }
      const batch = (data?.users || []) as VerifiedSupabaseUser[];
      allRawUsers.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }

    return allRawUsers
      .filter((u) => Boolean(u.email))
      .map((u) => this.toManagedUser(u))
      .sort((a, b) => {
        const rank: Record<CanonicalCrmRole, number> = {
          super_admin: 3,
          admin: 2,
          manager: 1,
          user: 0,
        };
        if (rank[b.role] !== rank[a.role]) return rank[b.role] - rank[a.role];
        return a.name.localeCompare(b.name);
      });
  }

  /**
   * Fetches a single CRM user by ID from Supabase Auth.
   */
  public async getUserById(id: string): Promise<{ raw: VerifiedSupabaseUser; managed: CrmManagedUser }> {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.admin.getUserById(id);
    if (error || !data?.user) {
      throw createCrmHttpError(404, 'User not found.');
    }
    const raw = data.user as VerifiedSupabaseUser;
    return { raw, managed: this.toManagedUser(raw) };
  }

  /**
   * Enforces role & self-modification rules:
   * 1. Only super_admin and admin may manage users (403).
   * 2. Nobody can edit or deactivate themselves (403).
   * 3. An admin cannot manage or assign super_admin (403).
   */
  private assertActorPermission(
    actor: AuthenticatedCrmUser,
    target: CrmManagedUser | null,
    newRole?: CanonicalCrmRole
  ): void {
    if (actor.role !== 'super_admin' && actor.role !== 'admin') {
      throw createCrmHttpError(403, 'Only Super Admins and Admins manage users.', 'FORBIDDEN_ROLE');
    }
    if (
      target &&
      (target.id === actor.id || target.email.toLowerCase() === actor.email.toLowerCase())
    ) {
      throw createCrmHttpError(
        403,
        'You can’t change your own access. Ask another admin.',
        'SELF_MODIFICATION_FORBIDDEN'
      );
    }
    if (
      actor.role === 'admin' &&
      (target?.role === 'super_admin' || newRole === 'super_admin')
    ) {
      throw createCrmHttpError(
        403,
        'Only a Super Admin can manage Super Admins.',
        'SUPER_ADMIN_REQUIRED'
      );
    }
  }

  private validateAndCleanWorkspaces(
    role: CanonicalCrmRole,
    rawWorkspaces: unknown
  ): string[] {
    if (role === 'super_admin' || role === 'admin') {
      return [...ALL_WORKSPACES];
    }
    const cleaned = cleanWorkspacesForRole(role, rawWorkspaces, false);
    if (cleaned.length === 0) {
      throw createCrmHttpError(400, 'Pick at least one workspace.', 'INVALID_WORKSPACES');
    }
    return cleaned;
  }

  private async countActiveSuperAdmins(): Promise<number> {
    const users = await this.listUsers();
    return users.filter((u) => u.role === 'super_admin' && u.status === 'active').length;
  }

  /**
   * Records a user management action in SocialAuditLog (shown on the CRM Activity Log page).
   */
  public async logUserActivity(params: {
    actor: string;
    action: string;
    entity: string;
    details: string;
    ipAddress?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    try {
      await contentPrisma.socialAuditLog.create({
        data: {
          actor: params.actor,
          action: params.action,
          entity: params.entity,
          details: params.details,
          ipAddress: params.ipAddress || null,
          metadata: params.metadata || {},
        },
      });
    } catch (err: any) {
      console.warn('[CrmUsersService] Activity log notice:', err?.message);
    }
  }

  /**
   * Invites a new user to the Social CRM.
   */
  public async inviteUser(
    actor: AuthenticatedCrmUser,
    input: { email?: string; name?: string; role?: string; workspaces?: unknown },
    crmOrigin: string,
    ipAddress?: string
  ): Promise<CrmManagedUser> {
    const email = (input.email || '').trim().toLowerCase();
    if (!email || !EMAIL_REGEX.test(email)) {
      throw createCrmHttpError(400, 'Enter a valid email address.', 'INVALID_EMAIL');
    }

    const rawRole = (input.role || '').trim().toLowerCase() as CanonicalCrmRole;
    if (!VALID_ROLES.includes(rawRole)) {
      throw createCrmHttpError(400, 'Pick a role.', 'INVALID_ROLE');
    }

    this.assertActorPermission(actor, null, rawRole);
    const workspaces = this.validateAndCleanWorkspaces(rawRole, input.workspaces);
    const name = (input.name || '').trim() || email.split('@')[0];

    const existingUsers = await this.listUsers();
    if (existingUsers.some((u) => u.email.toLowerCase() === email)) {
      throw createCrmHttpError(409, `${email} already has an account.`, 'DUPLICATE_EMAIL');
    }

    const supabase = await getSupabaseClient();
    const redirectTo = `${crmOrigin}/set-password`;
    const nowIso = new Date().toISOString();

    let createdUser: VerifiedSupabaseUser | null = null;

    // 1. Try inviteUserByEmail
    const inviteRes = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { name, full_name: name },
      redirectTo,
    });

    if (!inviteRes.error && inviteRes.data?.user) {
      createdUser = inviteRes.data.user as VerifiedSupabaseUser;
    } else {
      // Fallback: if Supabase's built-in email limit was hit, generate the invite link and send via SMTP
      const linkRes = await supabase.auth.admin.generateLink({
        type: 'invite',
        email,
        options: {
          data: { name, full_name: name },
          redirectTo,
        },
      });

      if (linkRes.error || !linkRes.data?.user) {
        const msg = inviteRes.error?.message || linkRes.error?.message || 'Failed to invite user';
        if (msg.toLowerCase().includes('already')) {
          throw createCrmHttpError(409, `${email} already has an account.`, 'DUPLICATE_EMAIL');
        }
        throw createCrmHttpError(500, msg);
      }

      createdUser = linkRes.data.user as VerifiedSupabaseUser;
      const actionLink = linkRes.data.properties?.action_link;
      if (actionLink) {
        await this.sendInviteEmailViaSmtp(email, name, rawRole, actionLink).catch(() => {});
      }
    }

    // 2. Persist authoritative app_metadata (role, workspaces, name, status: 'invited', roleVersion: 2)
    const { data: updatedData, error: updateErr } = await supabase.auth.admin.updateUserById(
      createdUser.id,
      {
        app_metadata: {
          ...(createdUser.app_metadata || {}),
          name,
          role: rawRole,
          workspaces,
          status: 'invited',
          deactivated: false,
          password_set: false,
          invitedAt: nowIso,
          roleVersion: 2,
        },
        user_metadata: {
          ...(createdUser.user_metadata || {}),
          name,
          full_name: name,
        },
      }
    );

    if (updateErr || !updatedData?.user) {
      throw createCrmHttpError(500, updateErr?.message || 'Failed to save user role metadata');
    }

    const managed = this.toManagedUser(updatedData.user as VerifiedSupabaseUser);

    await this.logUserActivity({
      actor: `${actor.name} (${actor.email})`,
      action: 'USER_INVITED',
      entity: `${managed.name} (${managed.email})`,
      details: `Invited ${managed.name} (${managed.email}) as ${managed.role} for workspaces [${managed.workspaces.join(', ')}]`,
      ipAddress,
      metadata: {
        actorId: actor.id,
        targetUserId: managed.id,
        role: managed.role,
        workspaces: managed.workspaces,
      },
    });

    return managed;
  }

  /**
   * Changes a user's role and/or assigned workspaces.
   */
  public async updateUserAccess(
    actor: AuthenticatedCrmUser,
    targetId: string,
    input: { role?: string; workspaces?: unknown },
    ipAddress?: string
  ): Promise<CrmManagedUser> {
    const { raw, managed: target } = await this.getUserById(targetId);

    const newRole: CanonicalCrmRole =
      input.role !== undefined
        ? (String(input.role).trim().toLowerCase() as CanonicalCrmRole)
        : target.role;

    if (!VALID_ROLES.includes(newRole)) {
      throw createCrmHttpError(400, 'Pick a role.', 'INVALID_ROLE');
    }

    this.assertActorPermission(actor, target, newRole);

    if (
      target.role === 'super_admin' &&
      newRole !== 'super_admin' &&
      target.status === 'active'
    ) {
      const activeSupers = await this.countActiveSuperAdmins();
      if (activeSupers <= 1) {
        throw createCrmHttpError(
          409,
          'The CRM needs at least one active Super Admin.',
          'LAST_SUPER_ADMIN'
        );
      }
    }

    const newWorkspaces = this.validateAndCleanWorkspaces(
      newRole,
      input.workspaces !== undefined ? input.workspaces : target.workspaces
    );

    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.admin.updateUserById(target.id, {
      app_metadata: {
        ...(raw.app_metadata || {}),
        role: newRole,
        workspaces: newWorkspaces,
        roleVersion: 2,
      },
    });

    if (error || !data?.user) {
      throw createCrmHttpError(500, error?.message || 'Failed to update user access');
    }

    const updated = this.toManagedUser(data.user as VerifiedSupabaseUser);

    await this.logUserActivity({
      actor: `${actor.name} (${actor.email})`,
      action: 'USER_ACCESS_UPDATED',
      entity: `${updated.name} (${updated.email})`,
      details: `Changed access for ${updated.name} (${updated.email}): role ${target.role} → ${updated.role}; workspaces [${target.workspaces.join(', ')}] → [${updated.workspaces.join(', ')}]`,
      ipAddress,
      metadata: {
        actorId: actor.id,
        targetUserId: updated.id,
        oldRole: target.role,
        newRole: updated.role,
        oldWorkspaces: target.workspaces,
        newWorkspaces: updated.workspaces,
      },
    });

    return updated;
  }

  /**
   * Deactivates a user, bans their Supabase account ('876000h'), and immediately revokes all open sessions.
   */
  public async deactivateUser(
    actor: AuthenticatedCrmUser,
    targetId: string,
    ipAddress?: string
  ): Promise<CrmManagedUser> {
    const { raw, managed: target } = await this.getUserById(targetId);
    this.assertActorPermission(actor, target);

    if (target.role === 'super_admin' && target.status === 'active') {
      const activeSupers = await this.countActiveSuperAdmins();
      if (activeSupers <= 1) {
        throw createCrmHttpError(
          409,
          'The CRM needs at least one active Super Admin.',
          'LAST_SUPER_ADMIN'
        );
      }
    }

    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.admin.updateUserById(target.id, {
      ban_duration: '876000h',
      app_metadata: {
        ...(raw.app_metadata || {}),
        role: target.role,
        workspaces: target.workspaces,
        status: 'deactivated',
        deactivated: true,
        roleVersion: 2,
      },
    });

    if (error || !data?.user) {
      throw createCrmHttpError(500, error?.message || 'Failed to deactivate user');
    }

    revokeUserSessions(target.id, target.email);
    const updated = this.toManagedUser(data.user as VerifiedSupabaseUser);

    await this.logUserActivity({
      actor: `${actor.name} (${actor.email})`,
      action: 'USER_DEACTIVATED',
      entity: `${updated.name} (${updated.email})`,
      details: `Deactivated ${updated.name} (${updated.email}) [role: ${updated.role}]`,
      ipAddress,
      metadata: {
        actorId: actor.id,
        targetUserId: updated.id,
        previousStatus: target.status,
      },
    });

    return updated;
  }

  /**
   * Reactivates a deactivated user ('ban_duration: none').
   */
  public async reactivateUser(
    actor: AuthenticatedCrmUser,
    targetId: string,
    ipAddress?: string
  ): Promise<CrmManagedUser> {
    const { raw, managed: target } = await this.getUserById(targetId);
    this.assertActorPermission(actor, target);

    const restoredStatus: CrmUserStatus =
      raw.last_sign_in_at || raw.app_metadata?.password_set ? 'active' : 'invited';

    restoreUserSessions(target.id, target.email);
    setLiveUserOverride({
      id: target.id,
      email: target.email,
      name: target.name,
      role: target.role,
      workspaces: target.workspaces,
      status: restoredStatus,
    });

    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.admin.updateUserById(target.id, {
      ban_duration: 'none',
      app_metadata: {
        ...(raw.app_metadata || {}),
        role: target.role,
        workspaces: target.workspaces,
        status: restoredStatus,
        deactivated: false,
        roleVersion: 2,
      },
    });

    if (error || !data?.user) {
      throw createCrmHttpError(500, error?.message || 'Failed to reactivate user');
    }

    const updated = this.toManagedUser(data.user as VerifiedSupabaseUser);

    await this.logUserActivity({
      actor: `${actor.name} (${actor.email})`,
      action: 'USER_REACTIVATED',
      entity: `${updated.name} (${updated.email})`,
      details: `Reactivated ${updated.name} (${updated.email}) [role: ${updated.role}, status: ${updated.status}]`,
      ipAddress,
      metadata: {
        actorId: actor.id,
        targetUserId: updated.id,
        restoredStatus: updated.status,
      },
    });

    return updated;
  }

  /**
   * Resends an invitation email to an invited user.
   */
  public async resendInvite(
    actor: AuthenticatedCrmUser,
    targetId: string,
    crmOrigin: string,
    ipAddress?: string
  ): Promise<CrmManagedUser> {
    const { raw, managed: target } = await this.getUserById(targetId);
    this.assertActorPermission(actor, target);

    if (target.status !== 'invited') {
      throw createCrmHttpError(409, 'Only invited people get a new invitation.', 'NOT_INVITED');
    }

    const supabase = await getSupabaseClient();
    const redirectTo = `${crmOrigin}/set-password`;
    const nowIso = new Date().toISOString();

    const inviteRes = await supabase.auth.admin.inviteUserByEmail(target.email, {
      data: { name: target.name, full_name: target.name },
      redirectTo,
    });

    if (inviteRes.error) {
      // Generate fresh invite/magic link and send via SMTP
      const linkRes = await supabase.auth.admin.generateLink({
        type: 'invite',
        email: target.email,
        options: {
          data: { name: target.name, full_name: target.name },
          redirectTo,
        },
      });
      const actionLink = linkRes.data?.properties?.action_link;
      if (actionLink) {
        await this.sendInviteEmailViaSmtp(
          target.email,
          target.name,
          target.role,
          actionLink
        ).catch(() => {});
      }
    }

    const { data, error } = await supabase.auth.admin.updateUserById(target.id, {
      app_metadata: {
        ...(raw.app_metadata || {}),
        invitedAt: nowIso,
        status: 'invited',
        roleVersion: 2,
      },
    });

    if (error || !data?.user) {
      throw createCrmHttpError(500, error?.message || 'Failed to update invitation timestamp');
    }

    const updated = this.toManagedUser(data.user as VerifiedSupabaseUser);

    await this.logUserActivity({
      actor: `${actor.name} (${actor.email})`,
      action: 'USER_INVITE_RESENT',
      entity: `${updated.name} (${updated.email})`,
      details: `Resent invitation email to ${updated.name} (${updated.email})`,
      ipAddress,
      metadata: {
        actorId: actor.id,
        targetUserId: updated.id,
        invitedAt: nowIso,
      },
    });

    return updated;
  }

  /**
   * Sends a password reset link ("Forgot password"). Always resolves without throwing
   * so unknown addresses do not reveal account existence.
   */
  public async sendForgotPasswordEmail(email: string, crmOrigin: string): Promise<void> {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) return;

    try {
      const users = await this.listUsers();
      const matched = users.find((u) => u.email.toLowerCase() === cleanEmail);
      if (!matched || matched.status === 'deactivated') {
        return;
      }

      const supabaseUrl = getSupabaseUrl();
      const serviceKey = await getSupabaseServiceKey();
      if (!supabaseUrl || !serviceKey) return;

      const redirectTo = `${crmOrigin}/set-password`;
      const isolatedClient = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });

      const resetRes = await isolatedClient.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo,
      });

      if (resetRes.error) {
        const supabase = await getSupabaseClient();
        const linkRes = await supabase.auth.admin.generateLink({
          type: 'recovery',
          email: cleanEmail,
          options: { redirectTo },
        });
        const actionLink = linkRes.data?.properties?.action_link;
        if (actionLink) {
          await this.sendResetEmailViaSmtp(cleanEmail, matched.name, actionLink).catch(() => {});
        }
      }
    } catch {
      // Never leak errors to caller
    }
  }

  /**
   * Validates password strength: at least 10 characters, containing at least 1 letter and 1 number.
   */
  public validatePasswordStrength(password?: string): string | null {
    if (!password || typeof password !== 'string' || password.length < 10) {
      return 'Password must be at least 10 characters long.';
    }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return 'Password must include at least one letter and one number.';
    }
    return null;
  }

  /**
   * Sets a user's password using an invitation or recovery accessToken, activates an invited user,
   * and returns `{ user, token }` ready for immediate CRM sign-in.
   */
  public async setPasswordWithToken(
    input: { accessToken?: string; password?: string },
    ipAddress?: string
  ): Promise<{
    user: {
      id: string;
      email: string;
      name: string;
      role: CanonicalCrmRole;
      workspaces: string[];
      roleVersion: 2;
    };
    token: string;
  }> {
    const accessToken = (input.accessToken || '').trim();
    if (!accessToken) {
      throw createCrmHttpError(
        401,
        'This link has expired or was already used. Ask for a new one.',
        'INVALID_TOKEN'
      );
    }

    const pwError = this.validatePasswordStrength(input.password);
    if (pwError) {
      throw createCrmHttpError(400, pwError, 'WEAK_PASSWORD');
    }

    const tokenHash = hashToken(accessToken);
    if (usedPasswordTokenHashes.has(tokenHash)) {
      throw createCrmHttpError(
        401,
        'This link has expired or was already used. Ask for a new one.',
        'TOKEN_ALREADY_USED'
      );
    }

    const supabase = await getSupabaseClient();
    const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      throw createCrmHttpError(
        401,
        'This link has expired or was already used. Ask for a new one.',
        'INVALID_TOKEN'
      );
    }

    const rawUser = userData.user as VerifiedSupabaseUser;
    if (isSupabaseUserDeactivated(rawUser)) {
      throw createCrmHttpError(
        401,
        'This account is deactivated. Ask an admin to reactivate it.',
        'ACCOUNT_DEACTIVATED'
      );
    }

    const managedBefore = this.toManagedUser(rawUser);

    const { data: updatedData, error: updateErr } = await supabase.auth.admin.updateUserById(
      rawUser.id,
      {
        password: input.password!,
        email_confirm: true,
        app_metadata: {
          ...(rawUser.app_metadata || {}),
          name: managedBefore.name,
          role: managedBefore.role,
          workspaces: managedBefore.workspaces,
          status: 'active',
          deactivated: false,
          password_set: true,
          roleVersion: 2,
        },
      }
    );

    if (updateErr || !updatedData?.user) {
      throw createCrmHttpError(500, updateErr?.message || 'Failed to update password');
    }

    usedPasswordTokenHashes.add(tokenHash);
    const managed = this.toManagedUser(updatedData.user as VerifiedSupabaseUser);

    const sessionToken = generateCrmSessionToken({
      id: managed.id,
      email: managed.email,
      name: managed.name,
      role: managed.role,
      workspaces: managed.workspaces,
      roleVersion: 2,
    });

    await this.logUserActivity({
      actor: `${managed.name} (${managed.email})`,
      action: 'USER_PASSWORD_SET',
      entity: `${managed.name} (${managed.email})`,
      details: `Password set and account activated for ${managed.name} (${managed.email})`,
      ipAddress,
      metadata: {
        userId: managed.id,
        role: managed.role,
      },
    });

    return {
      user: {
        id: managed.id,
        email: managed.email,
        name: managed.name,
        role: managed.role,
        workspaces: managed.workspaces,
        roleVersion: 2,
      },
      token: sessionToken,
    };
  }

  private async sendInviteEmailViaSmtp(
    email: string,
    name: string,
    role: string,
    actionLink: string
  ): Promise<void> {
    await sendSmtpEmail({
      to: email,
      subject: 'You are invited to Leaders Performance Social CRM',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111827;">
          <h2 style="margin-top: 0;">Welcome to Leaders Performance Social CRM</h2>
          <p>Hello ${name},</p>
          <p>You have been invited to join the Leaders Performance Social CRM with the role <strong>${role.replace('_', ' ')}</strong>.</p>
          <p style="margin: 24px 0;">
            <a href="${actionLink}" style="background-color: #111827; color: #ffffff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">
              Set Your Password &amp; Sign In
            </a>
          </p>
          <p style="font-size: 12px; color: #6b7280;">If the button doesn't open, copy and paste this link: ${actionLink}</p>
        </div>
      `,
    });
  }

  private async sendResetEmailViaSmtp(
    email: string,
    name: string,
    actionLink: string
  ): Promise<void> {
    await sendSmtpEmail({
      to: email,
      subject: 'Reset your Leaders Performance Social CRM password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111827;">
          <h2 style="margin-top: 0;">Reset Your Password</h2>
          <p>Hello ${name},</p>
          <p>Click the button below to choose a new password for your Leaders Performance Social CRM account.</p>
          <p style="margin: 24px 0;">
            <a href="${actionLink}" style="background-color: #111827; color: #ffffff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">
              Choose a New Password
            </a>
          </p>
          <p style="font-size: 12px; color: #6b7280;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `,
    });
  }
}

export const crmUsersService = new CrmUsersService();
