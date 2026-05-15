const { OAuth2Client } = require('google-auth-library');
const { findUserByEmail, createUser, generateToken } = require('../services/authService');
const { linkBagToUser } = require('../services/bagService');
const { checkAndAwardChallenge } = require('../services/challengeService');
const nfcTokenService = require('../services/nfcTokenService');
const deviceService = require('../services/deviceService');
const logger = require('../config/logger');

const ALLOW_OTP_IN_RESPONSE = process.env.SHOW_OTP_IN_RESPONSE !== 'false';
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * POST /auth/google
 * Body: { credential, bagUid }
 * 
 * Authenticates user with Google OAuth token
 */
const googleAuth = async (req, res, next) => {
  try {
    const { credential, bagUid, nfcToken, deviceFingerprint } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        data: null,
        message: 'Google credential is required',
      });
    }

    // Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;

    logger.info(`Google auth attempt: email=${email}`);

    // Check if user exists
    let user = await findUserByEmail(email);

    if (user) {
      // Existing-user Google login goes through the same NFC + device gates
      // as the email/PIN login — bypassing them would defeat the purpose.
      let nfcTokenRow = null;
      if (nfcTokenService.REQUIRE_NFC_TOKEN) {
        const tokenCheck = await nfcTokenService.validateToken(nfcToken, { expectedUserId: user.id });
        if (tokenCheck.error) {
          logger.warn(`Google login blocked (${tokenCheck.error}) for userId=${user.id}`);
          return res.status(403).json({
            success: false,
            code: tokenCheck.error,
            message: 'Please tap your Pacific Sunday bag to sign in.',
          });
        }
        nfcTokenRow = tokenCheck.row;
      }

      if (deviceFingerprint) {
        const trusted = await deviceService.findTrustedDevice(user.id, deviceFingerprint);
        if (!trusted) {
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
          return res.status(200).json({
            success: true,
            data: {
              requiresDeviceOtp: true,
              challengeId: challenge.challengeId,
              email: user.email,
              otp: ALLOW_OTP_IN_RESPONSE ? challenge.otp : undefined,
              deviceLabel: deviceService.deriveDeviceLabel(meta.userAgent),
            },
            message: 'New device — please enter the verification code sent to your email.',
          });
        }
        const meta = deviceService.extractRequestMeta(req);
        await deviceService.upsertDevice({
          userId: user.id,
          fingerprintHash: deviceFingerprint,
          ...meta,
        });
      }

      if (nfcTokenRow) await nfcTokenService.consumeToken(nfcTokenRow.id);
      const token = generateToken(user.id, user.email);
      logger.info(`Google login successful: userId=${user.id}`);
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
            photoUrl: user.profile?.golfPassport?.photoUrl || picture,
            createdAt: user.createdAt,
          },
        },
        message: 'Logged in successfully with Google.',
      });
    } else {
      // New user trying to login - they must register via NFC tap first
      if (!bagUid) {
        return res.status(404).json({
          success: false,
          data: null,
          message: 'No account found with this Google account. Please register first by tapping your NFC bag.',
        });
      }

      // Create user without password (Google OAuth)
      user = await createUser(name, email, null, null, googleId);

      // Link bag to new user
      await linkBagToUser(bagUid, user.id);

      // Trust the registering device (same as email register flow).
      if (deviceFingerprint) {
        const meta = deviceService.extractRequestMeta(req);
        deviceService
          .upsertDevice({ userId: user.id, fingerprintHash: deviceFingerprint, ...meta })
          .catch((err) => logger.warn(`Trust device on Google register failed: ${err.message}`));
      }

      // Achievement trigger
      checkAndAwardChallenge(user.id, 'bag_registered', { bagUid }).catch((err) =>
        logger.error(`Challenge trigger (bag_registered) failed: ${err.message}`),
      );

      const token = generateToken(user.id, user.email);

      logger.info(`Google registration successful: userId=${user.id}, bagUid=${bagUid}`);

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
            photoUrl: picture || null,
            createdAt: user.createdAt,
          },
        },
        message: 'Account created successfully with Google.',
      });
    }
  } catch (error) {
    logger.error(`Google auth error: ${error.message}`);

    if (error.message.includes('Token used too late') || error.message.includes('Invalid token')) {
      return res.status(401).json({
        success: false,
        data: null,
        message: 'Google token expired. Please try again.',
      });
    }

    return res.status(500).json({
      success: false,
      data: null,
      message: `Google authentication failed: ${error.message}`,
    });
  }
};

module.exports = { googleAuth };
