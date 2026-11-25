"use strict";

const { reject } = require("./dailyRoom");

function chatText(value) {
  if (typeof value !== "string" || value.length > 280 || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    reject(400, "DAILY_CHAT_TEXT", "Enter a message from 1 to 280 characters.");
  }
  return value.trim();
}

function spectatorChatSetting(value = false) {
  if (typeof value !== "boolean") reject(400, "DAILY_SPECTATOR_CHAT_INVALID", "Choose whether spectators may join the room chat.");
  return value;
}

function requireChatAccess(room, userId) {
  if (typeof userId !== "string" || !userId ||
      (!room.members.some(member => member.id === userId) && room.allowSpectatorChat !== true)) {
    reject(403, "DAILY_MEMBERSHIP_REQUIRED", "Only room members can use this chat.");
  }
}

function chatView(room, appearance = () => null) {
  const readOnly = Boolean(room.finished || room.void || room.closed);
  return { messages: (room.chat || []).map(({ requestId: _requestId, ...message }) => ({
    ...message, reactions: message.reactions || [],
    usernameColour: appearance(message.userId)?.primaryColour || null,
  })),
    readOnly, canPost: !readOnly };
}

// Reuse authenticated sockets without putting message contents on a broadcast.
// Re-check both the session and this room's current chat policy before emit.
function createDailyChatPublisher({ getIo, authorizeHandshake, canRead }) {
  return roomId => {
    for (const socket of getIo()?.sockets?.sockets?.values() || []) {
      try {
        const authority = authorizeHandshake(socket.handshake);
        if (canRead(roomId, authority.userId)) socket.emit("daily.chat.changed", { roomId });
      } catch { /* A revoked session or unauthorized spectator receives no room signal. */ }
    }
  };
}

module.exports = { chatText, spectatorChatSetting, requireChatAccess, chatView, createDailyChatPublisher };
