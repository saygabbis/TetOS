import { buildConfirmationMessage, shouldRequireConfirmation } from "./naturalOperationGuard.js";

export class OperationRouter {
  constructor({ channelAdmin, documentModule, adminUserId = "", pendingConfirmations = null } = {}) {
    this.channelAdmin = channelAdmin;
    this.documentModule = documentModule;
    this.adminUserId = String(adminUserId ?? "").trim();
    this.pendingConfirmations = pendingConfirmations;
  }

  /** Dona sempre; outra pessoa só se for o TETOS_ADMIN_USER_ID configurado (sem ele, ninguém mais). */
  isAdmin(userId, { isOwner = false } = {}) {
    if (isOwner) return true;
    if (!this.adminUserId) return false;
    return String(userId ?? "").trim() === this.adminUserId;
  }

  execute({ type, userId, payload = {}, isOwner = false } = {}) {
    if (!type) return null;

    if (type === "channel_admin") {
      if (!this.isAdmin(userId, { isOwner })) {
        return { error: "not authorized" };
      }
      if (!payload?.confirmed && this.pendingConfirmations && shouldRequireConfirmation(type, payload)) {
        const entry = this.pendingConfirmations.create({ userId, type, payload });
        return {
          confirmationRequired: true,
          confirmationId: entry.id,
          message: buildConfirmationMessage(type, payload)
        };
      }
      return this.channelAdmin.execute(payload);
    }

    // Documentos são arquivos do computador da dona.
    if (type === "document_list") {
      if (!this.isAdmin(userId, { isOwner })) return { error: "not authorized" };
      return { documents: this.documentModule.list() };
    }

    if (type === "document_read") {
      if (!this.isAdmin(userId, { isOwner })) return { error: "not authorized" };
      return { document: this.documentModule.read(payload.id) };
    }

    if (type === "document_write") {
      if (!this.isAdmin(userId, { isOwner })) {
        return { error: "not authorized" };
      }
      if (!payload?.confirmed && this.pendingConfirmations && shouldRequireConfirmation(type, payload)) {
        const entry = this.pendingConfirmations.create({ userId, type, payload });
        return {
          confirmationRequired: true,
          confirmationId: entry.id,
          message: buildConfirmationMessage(type, payload)
        };
      }
      return this.documentModule.assistWrite(payload.id, payload.content);
    }

    return null;
  }
}
