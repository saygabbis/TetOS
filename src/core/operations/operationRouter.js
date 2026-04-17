import { buildConfirmationMessage, shouldRequireConfirmation } from "./naturalOperationGuard.js";

export class OperationRouter {
  constructor({ channelAdmin, documentModule, adminUserId = "", pendingConfirmations = null } = {}) {
    this.channelAdmin = channelAdmin;
    this.documentModule = documentModule;
    this.adminUserId = String(adminUserId ?? "").trim();
    this.pendingConfirmations = pendingConfirmations;
  }

  isAdmin(userId) {
    if (!this.adminUserId) return true;
    return String(userId ?? "").trim() === this.adminUserId;
  }

  execute({ type, userId, payload = {} } = {}) {
    if (!type) return null;

    if (type === "channel_admin") {
      if (!this.isAdmin(userId)) {
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

    if (type === "document_list") {
      return { documents: this.documentModule.list() };
    }

    if (type === "document_read") {
      return { document: this.documentModule.read(payload.id) };
    }

    if (type === "document_write") {
      if (!this.isAdmin(userId)) {
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
