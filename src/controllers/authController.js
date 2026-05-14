const {
  hashPassword,
  verifyPassword,
  hashMpin,
  verifyMpin,
  generateToken,
  findUserByEmail,
  findUserByEmailOrUsername,
  findUserById,
  findUserByIdWithAuth,
  createUser,
} = require('../services/authService');
const { linkBagToUser } = require('../services/bagService');
const { checkAndAwardChallenge } = require('../services/challengeService');
const { recordReferral } = require('../services/referralService');
const nfcTokenService = require('../services/nfcTokenService');
const deviceService = require('../services/deviceService');
const logger = require('../config/logger');

const ALLOW_OTP_IN_RESPONSE = process.env.SHOW_OTP_IN_RESPONSE !== 'false';

/**
 * POST /auth/register
 * Body: { name, email, password, country, bagUid, deviceFingerprint? }
 *
 * Creates a new user account, links the bag, and (if a fingerprint is
 * provided) trusts the registering device. The registering browser is the
 * first device on the account by definition — we never want to OTP-prompt
 * the user a moment after they set their PIN.
 */
const register = async (req, res, next) => {
  try {
    const { name, email: rawEmail, mpin, country, bagUid, referralCode, deviceFingerprint } = req.body;
    const email = rawEmail?.trim().toLowerCase();

    logger.info(`Register attempt: email=${email}, bagUid=${bagUid}`);

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        data: null,
        message: 'An account with that email address already exists.',
      });
    }

    const hashedMpin = await hashMpin(mpin);
    const user = await createUser(name, email, null, country, null, hashedMpin);

    // Link bag to new user (sets registered=true, userId, registeredAt)
    await linkBagToUser(bagUid, user.id);

    // Trust the device the user registered from. If the frontend didn't send
    // a fingerprint we just skip — next login from this same browser will
    // trigger a (legitimate) device-verification OTP.
    if (deviceFingerprint) {
      const meta = deviceService.extractRequestMeta(req);
      deviceService
        .upsertDevice({ userId: user.id, fingerprintHash: deviceFingerprint, ...meta })
        .catch((err) => logger.warn(`Trust device on register failed: ${err.message}`));
    }

    // Achievement triggers — fire-and-forget; never block registration.
    checkAndAwardChallenge(user.id, 'bag_registered', { bagUid }).catch((err) =>
      logger.error(`Challenge trigger (bag_registered) failed: ${err.message}`),
    );

    // Referral: record + award the referrer if a valid code was supplied.
    if (referralCode) {
      recordReferral(referralCode, user.id).catch((err) =>
        logger.error(`Referral recording failed: ${err.message}`),
      );
    }

    const token = generateToken(user.id, user.email);

    logger.info(`Registration successful: userId=${user.id}, bagUid=${bagUid}`);

    return res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.profile.name,
          email: user.email,
          username: user.username,
          country: user.profile.country,
          photoUrl: user.profile.golfPassport?.photoUrl || null,
          createdAt: user.createdAt,
        },
      },
      message: 'Account created successfully.',
    });
  } catch (error) {
    logger.error(`Register error: ${error.message}`);

    if (error.message === 'A user with that email already exists') {
      return res.status(409).json({
        success: false,
        data: null,
        message: error.message,
      });
    }

    next(error);
  }
};

/**
 * POST /auth/login
 * Body: { email, mpin, nfcToken, deviceFingerprint? }
 *
 * Gated by three checks (in order):
 *   1. NFC tap token — proves the user came through /n after tapping their
 *      registered bag. Without it (when REQUIRE_NFC_TOKEN is on), no login.
 *   2. PIN match — same as before.
 *   3. Device trust — if the device fingerprint isn't already on the user's
 *      trusted list, we hold the login and issue a one-time email OTP.
 *      The client completes the login via /auth/verify-device-otp.
 */
const login = async (req, res, next) => {
  try {
    const { email: rawEmail, mpin, nfcToken, deviceFingerprint } = req.body;
    const email = rawEmail?.trim().toLowerCase();

    logger.info(`Login attempt: identifier=${email || '(via nfcToken)'}`);

    // Prefer the nfcToken as the user identity: the bag tap already proved
    // who's logging in, so the email field on the form is just a label
    // (and it's masked — m***@example.com — so it would never match a real
    // lookup anyway). If NFC isn't required (dev mode), fall back to the
    // classic email/username lookup so seeded test users still work.
    let user = null;
    if (nfcToken) {
      const peek = await nfcTokenService.validateToken(nfcToken);
      if (peek.row) {
        user = await findUserByIdWithAuth(peek.row.userId);
      }
    }
    if (!user) {
      user = await findUserByEmailOrUsername(email);
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid username/email or M-PIN.',
      });
    }

    if (!user.mpin) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'No M-PIN set for this account. Please contact support.',
      });
    }

    // ── Gate 1: NFC tap token ──────────────────────────────────────────────
    let nfcTokenRow = null;
    if (nfcTokenService.REQUIRE_NFC_TOKEN) {
      const result = await nfcTokenService.validateToken(nfcToken, { expectedUserId: user.id });
      if (result.error) {
        logger.warn(`Login blocked (${result.error}) for userId=${user.id}`);
        return res.status(403).json({
          success: false,
          data: null,
          code: result.error,
          message:
            result.error === 'NFC_TOKEN_MISSING'
              ? 'Please tap your Pacific Sunday bag to sign in.'
              : 'Your NFC tap is no longer valid. Tap your bag again to sign in.',
        });
      }
      nfcTokenRow = result.row;
    }

    // ── Gate 2: PIN ────────────────────────────────────────────────────────
    const mpinMatch = await verifyMpin(mpin, user.mpin);
    if (!mpinMatch) {
      logger.warn(`Failed login attempt for identifier=${email}`);
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid username/email or M-PIN.',
      });
    }

    // ── Gate 3: Device trust ───────────────────────────────────────────────
    if (deviceFingerprint) {
      const trusted = await deviceService.findTrustedDevice(user.id, deviceFingerprint);
      if (!trusted) {
        // Unknown device — don't issue the JWT yet. Burn the NFC token (it's
        // single-use; the user has proven they have the bag) and stash the
        // pending login behind an email OTP.
        const meta = deviceService.extractRequestMeta(req);
        const challenge = await deviceService.issueDeviceOtp({
          userId: user.id,
          fingerprintHash: deviceFingerprint,
          userAgent: meta.userAgent,
          ipAddress: meta.ipAddress,
          nfcTokenId: nfcTokenRow?.id,
          email: user.email,
        });
        if (nfcTokenRow) await nfcTokenService.consumeToken(nfcTokenRow.id);

        logger.info(`Device OTP issued for userId=${user.id} (challengeId=${challenge.challengeId})`);

        return res.status(200).json({
          success: true,
          data: {
            requiresDeviceOtp: true,
            challengeId: challenge.challengeId,
            email: user.email, // safe to reveal — they already passed PIN
            // Dev fallback: return the OTP in the response body until SMTP is
            // wired up. Same pattern the manual already documents for
            // forgot-PIN. Toggle off via SHOW_OTP_IN_RESPONSE=false in prod.
            otp: ALLOW_OTP_IN_RESPONSE ? challenge.otp : undefined,
            deviceLabel: deviceService.deriveDeviceLabel(meta.userAgent),
          },
          message: 'New device — please enter the verification code sent to your email.',
        });
      }
      // Known device — update lastSeenAt.
      const meta = deviceService.extractRequestMeta(req);
      await deviceService.upsertDevice({
        userId: user.id,
        fingerprintHash: deviceFingerprint,
        ...meta,
      });
    }

    // All gates passed — issue JWT and burn the NFC token.
    if (nfcTokenRow) await nfcTokenService.consumeToken(nfcTokenRow.id);
    const token = generateToken(user.id, user.email);

    logger.info(`Login successful: userId=${user.id}`);

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.profile?.name,
          email: user.email,
          username: user.username,
          country: user.profile?.country,
          photoUrl: user.profile?.golfPassport?.photoUrl || null,
          createdAt: user.createdAt,
        },
      },
      message: 'Logged in successfully.',
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /auth/quick-login
 * Body: { userId, mpin, deviceFingerprint }
 *
 * Fast re-login for a returning user on a *trusted* device — no NFC tap
 * required. The device must already have a non-revoked UserDevice row for
 * this user (which means it cleared the NFC + email-OTP gates at some
 * earlier login). PIN still required, so a stolen phone alone isn't enough.
 *
 * If the device is unknown or revoked, returns { requiresNfcTap: true } so
 * the frontend can fall back to the "tap your bag" landing.
 */
const quickLogin = async (req, res, next) => {
  try {
    const { userId, mpin, deviceFingerprint } = req.body;
    if (!userId || !mpin || !deviceFingerprint) {
      return res.status(400).json({
        success: false,
        message: 'userId, mpin, and deviceFingerprint are required.',
      });
    }

    const user = await findUserByIdWithAuth(Number(userId));
    if (!user || !user.mpin) {
      // Don't leak existence — same shape as NFC-required response so a
      // probe can't enumerate accounts via this endpoint.
      return res.status(403).json({
        success: false,
        data: { requiresNfcTap: true },
        message: 'Please tap your Pacific Sunday bag to sign in.',
      });
    }

    const trusted = await deviceService.findTrustedDevice(user.id, deviceFingerprint);
    if (!trusted) {
      logger.info(`quickLogin denied (untrusted device) for userId=${user.id}`);
      return res.status(403).json({
        success: false,
        data: { requiresNfcTap: true },
        message: 'This device isn’t recognised. Tap your bag to sign in.',
      });
    }

    const mpinMatch = await verifyMpin(mpin, user.mpin);
    if (!mpinMatch) {
      logger.warn(`quickLogin wrong PIN for userId=${user.id}`);
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Invalid PIN.',
      });
    }

    // Refresh device's lastSeenAt + request meta.
    const meta = deviceService.extractRequestMeta(req);
    await deviceService.upsertDevice({
      userId: user.id,
      fingerprintHash: deviceFingerprint,
      ...meta,
    });

    const token = generateToken(user.id, user.email);
    logger.info(`quickLogin success: userId=${user.id}`);

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.profile?.name,
          email: user.email,
          username: user.username,
          country: user.profile?.country,
          photoUrl: user.profile?.golfPassport?.photoUrl || null,
          createdAt: user.createdAt,
        },
      },
      message: 'Logged in successfully.',
    });
  } catch (error) {
    logger.error(`quickLogin error: ${error.message}`);
    next(error);
  }
};

/**
 * POST /auth/verify-device-otp
 * Body: { challengeId, otp }
 *
 * Second half of an unknown-device login. The challenge record carries the
 * userId, fingerprint, and request meta we stashed during the PIN check;
 * on a correct OTP we trust the device and finish issuing the JWT.
 */
const verifyDeviceOtp = async (req, res, next) => {
  try {
    const { challengeId, otp } = req.body;
    if (!challengeId || !otp) {
      return res.status(400).json({
        success: false,
        message: 'challengeId and otp are required.',
      });
    }

    const challenge = await require('../config/db').prisma.deviceVerificationOtp.findUnique({
      where: { id: Number(challengeId) },
    });
    if (!challenge) {
      return res.status(400).json({ success: false, message: 'Invalid or expired challenge.' });
    }

    const result = await deviceService.verifyDeviceOtp({
      challengeId: Number(challengeId),
      otp,
      expectedUserId: challenge.userId,
    });
    if (result.error) {
      const msg =
        result.error === 'OTP_EXPIRED'
          ? 'This code has expired. Please sign in again.'
          : result.error === 'OTP_TOO_MANY_ATTEMPTS'
            ? 'Too many incorrect attempts. Please sign in again.'
            : result.error === 'OTP_USED'
              ? 'This code has already been used.'
              : 'Invalid code. Please try again.';
      return res.status(400).json({ success: false, code: result.error, message: msg });
    }

    // Trust this device going forward.
    await deviceService.upsertDevice({
      userId: challenge.userId,
      fingerprintHash: challenge.fingerprintHash,
      userAgent: challenge.userAgent,
      ipAddress: challenge.ipAddress,
    });

    // Load user for response.
    const user = await findUserById(challenge.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const token = generateToken(user.id, user.email);

    logger.info(`Device verified + login completed: userId=${user.id}`);

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.profile?.name,
          email: user.email,
          username: user.username,
          country: user.profile?.country,
          photoUrl: user.profile?.golfPassport?.photoUrl || null,
          createdAt: user.createdAt,
        },
      },
      message: 'Device verified. Logged in successfully.',
    });
  } catch (error) {
    logger.error(`verifyDeviceOtp error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /auth/devices — list the calling user's trusted devices.
 */
const listDevices = async (req, res, next) => {
  try {
    const devices = await deviceService.listDevices(req.user.id);
    return res.json({
      success: true,
      data: {
        devices: devices.map((d) => ({
          id: d.id,
          label: d.label,
          userAgent: d.userAgent,
          ipAddress: d.ipAddress,
          firstSeenAt: d.firstSeenAt,
          lastSeenAt: d.lastSeenAt,
        })),
      },
      message: 'Trusted devices retrieved.',
    });
  } catch (error) {
    logger.error(`listDevices error: ${error.message}`);
    next(error);
  }
};

/**
 * DELETE /auth/devices/:id — revoke trust for a device. Next login from it
 * will require the email-OTP gate again.
 */
const revokeDevice = async (req, res, next) => {
  try {
    const deviceId = parseInt(req.params.id, 10);
    if (!deviceId) {
      return res.status(400).json({ success: false, message: 'Invalid device id.' });
    }
    const result = await deviceService.revokeDevice(req.user.id, deviceId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Device not found.' });
    }
    logger.info(`Device revoked: userId=${req.user.id}, deviceId=${deviceId}`);
    return res.json({ success: true, message: 'Device revoked.' });
  } catch (error) {
    logger.error(`revokeDevice error: ${error.message}`);
    next(error);
  }
};

/**
 * GET /auth/me
 * Protected — requires valid JWT.
 */
const getMe = async (req, res, next) => {
  try {
    const user = req.user;
    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          name: user.profile?.name,
          email: user.email,
          username: user.username,
          country: user.profile?.country,
          photoUrl: user.profile?.golfPassport?.photoUrl || null,
          createdAt: user.createdAt,
        }
      },
      message: 'User profile retrieved successfully.',
    });
  } catch (error) {
    logger.error(`getMe error: ${error.message}`);
    next(error);
  }
};

module.exports = { register, login, quickLogin, verifyDeviceOtp, listDevices, revokeDevice, getMe };
