const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.CHATAI_ENCRYPTION_KEY || 'chatai-default-encryption-key-32b';

function deriveKey() {
    return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

function base64UrlDecode(input) {
    const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(`${normalized}${padding}`, 'base64');
}

function isLikelyPlaintextApiKey(value) {
    if (!value || typeof value !== 'string') {
        return false;
    }

    return /^(sk-|sess-|rk-|pk-)/i.test(value.trim());
}

function decryptCurrentFormat(encryptedKey) {
    const [ivHex, authTagHex, ciphertext] = String(encryptedKey).split(':');
    if (!ivHex || !authTagHex || !ciphertext) {
        return '';
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        deriveKey(),
        Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function decryptLegacyFernet(encryptedKey) {
    const token = base64UrlDecode(encryptedKey);
    if (token.length < 1 + 8 + 16 + 32 || token[0] !== 0x80) {
        return '';
    }

    const signingKey = deriveKey().subarray(0, 16);
    const encryptionKey = deriveKey().subarray(16, 32);

    const payload = token.subarray(0, token.length - 32);
    const expectedHmac = crypto.createHmac('sha256', signingKey).update(payload).digest();
    const actualHmac = token.subarray(token.length - 32);
    if (
        expectedHmac.length !== actualHmac.length ||
        !crypto.timingSafeEqual(expectedHmac, actualHmac)
    ) {
        return '';
    }

    const iv = token.subarray(9, 25);
    const ciphertext = token.subarray(25, token.length - 32);
    const decipher = crypto.createDecipheriv('aes-128-cbc', encryptionKey, iv);
    decipher.setAutoPadding(true);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
}

function encryptApiKey(plainKey) {
    if (!plainKey) {
        return '';
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);

    let encrypted = cipher.update(plainKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptApiKey(encryptedKey) {
    if (!encryptedKey) {
        return '';
    }

    if (isLikelyPlaintextApiKey(encryptedKey)) {
        return String(encryptedKey).trim();
    }

    try {
        const current = decryptCurrentFormat(encryptedKey);
        if (current) {
            return current;
        }
    } catch {}

    try {
        const legacy = decryptLegacyFernet(encryptedKey);
        if (legacy) {
            return legacy;
        }
    } catch {}

    return '';
}

function needsReencryption(encryptedKey) {
    if (!encryptedKey) {
        return false;
    }

    if (isLikelyPlaintextApiKey(encryptedKey)) {
        return true;
    }

    return !/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(String(encryptedKey));
}

function maskApiKey(key) {
    if (!key || key.length < 8) {
        return '****';
    }
    return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

module.exports = {
    encryptApiKey,
    decryptApiKey,
    maskApiKey,
    needsReencryption,
};
