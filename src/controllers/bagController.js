const iykService = require('../services/iykService');
const { recordScan } = require('../services/scanService');
const { findBagByUid } = require('../services/bagService');
const { checkMonthlyTapMilestone } = require('../services/challengeService');
const nfcTokenService = require('../services/nfcTokenService');
const { maskEmail } = require('../utils/maskEmail');
const { BAG_STATUS } = require('../models/index');
const logger = require('../config/logger');

/**
 * GET /bag?iykRef=
 *
 * Handles an NFC tap event:
 *  1. Resolves the iykRef with the IYK API (or dev bypass for DEV-UID-* refs)
 *  2. Looks up bag in DB by uid
 *  3. Returns bag details + registration status
 *
 * IYK redirects chip taps to <baseURL>?iykRef=<id>. The ref is a single-use
 * reference that resolves to the chip's UniversalID via GET /refs/:id.
 */
const handleScan = async (req, res, next) => {
  try {
    const { iykRef } = req.query;

    logger.info(`Bag scan request: iykRef=${iykRef}`);

    let uid = null;

    // ── Dev bypass: if iykRef starts with "DEV-UID-", skip IYK validation ──
    if (iykRef && iykRef.startsWith('DEV-UID-')) {
      logger.info(`Dev bypass: using uid=${iykRef} directly (skipping IYK)`);
      uid = iykRef;
    } else {
      // ── Production: resolve the ref with IYK API ──
      if (!iykRef) {
        return res.status(400).json({
          success: false,
          data: null,
          message: 'Missing required NFC parameter (iykRef).',
        });
      }

      try {
        const iykResult = await iykService.findChipByRef(iykRef);

        if (!iykResult || !iykResult.uid) {
          logger.warn(`IYK ref resolution rejected: iykRef=${iykRef}`);
          return res.status(400).json({
            success: false,
            data: null,
            message: 'NFC tap could not be verified. The reference may be invalid or already used.',
          });
        }

        uid = iykResult.uid;
      } catch (iykError) {
        logger.warn(`IYK validation error: ${iykError.message}`);
        return res.status(400).json({
          success: false,
          data: null,
          message: `NFC validation failed: ${iykError.message}`,
        });
      }
    }

    // ── Look up bag in DB ──
    const bag = await findBagByUid(uid);

    if (!bag) {
      logger.warn(`Bag not found in DB: uid=${uid}`);
      return res.status(404).json({
        success: false,
        data: null,
        message: 'This chip is not registered in our system.',
      });
    }

    // Check bag status
    if (bag.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        data: null,
        message: `This bag is ${bag.status.toLowerCase()}. Please contact support.`,
      });
    }

    // Ask Chromium to attach Client Hints on the next request — primes the
    // browser so a future tap from this device sends Sec-CH-UA-Model. Set
    // here as well as on the response so the user's next return hit carries
    // the model even before any cross-origin Permissions-Policy delegation.
    res.setHeader(
      'Accept-CH',
      'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version',
    );
    res.setHeader('Critical-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version');

    // Record the scan (non-fatal if it fails). Capture the User-Agent and
    // any UA-CH the frontend collected via navigator.userAgentData so the
    // my-bag history can show "SM-S901B — Android 14" instead of "K — Android".
    try {
      const clientHints = {
        model:
          req.headers['x-device-model'] || req.headers['sec-ch-ua-model'] || null,
        platform:
          req.headers['x-device-platform'] || req.headers['sec-ch-ua-platform'] || null,
        platformVersion:
          req.headers['x-device-platform-version'] ||
          req.headers['sec-ch-ua-platform-version'] ||
          null,
      };
      logger.info(
        `Scan headers: xModel=${req.headers['x-device-model'] || 'none'}, ` +
          `secChModel=${req.headers['sec-ch-ua-model'] || 'none'}, ` +
          `xPlatform=${req.headers['x-device-platform'] || 'none'}, ` +
          `xPlatformVer=${req.headers['x-device-platform-version'] || 'none'}`,
      );
      await recordScan(bag.id, {
        userAgent: req.headers['user-agent'],
        clientHints,
      });
    } catch (scanError) {
      logger.error(`Non-fatal scan log error: ${scanError.message}`);
    }

    // Achievement trigger — only meaningful for registered owners; check
    // whether this scan tipped them over the monthly threshold.
    if (bag.userId) {
      checkMonthlyTapMilestone(bag.userId).catch((err) =>
        logger.error(`Challenge trigger (nfc_tap_5x_month) failed: ${err.message}`),
      );
    }

    // ── Return bag details + status ──
    const bagDetails = {
      uid: bag.uid,
      tokenId: bag.tokenId,
      name: bag.bagType?.name || 'Pacific Sunday Bag',
      description: bag.bagType?.description || null,
      imageUrl: bag.bagType?.imageUrl || null,
      collection: bag.bagType?.collection || null,
    };

    if (!bag.registered) {
      logger.info(`Scan result: ${BAG_STATUS.NEW_USER} for uid=${uid}`);
      return res.status(200).json({
        success: true,
        data: {
          status: BAG_STATUS.NEW_USER,
          bag: bagDetails,
        },
        message: 'Bag is not yet registered. Please create an account.',
      });
    }

    // Mint a single-use NFC login token tied to the owner. The /n page
    // surfaces this to the user; the login endpoint refuses to authenticate
    // without it (when REQUIRE_NFC_TOKEN is on). Email is masked so a
    // stranger tapping the bag can't harvest the owner's full address.
    const { token: nfcToken, expiresAt: nfcTokenExpiresAt } =
      await nfcTokenService.issueToken({ userId: bag.userId, bagUid: bag.uid });

    // Best-effort cleanup of stale token rows; non-blocking.
    nfcTokenService.pruneOld().catch(() => {});

    logger.info(`Scan result: ${BAG_STATUS.EXISTING_USER} for uid=${uid}, userId=${bag.userId}`);
    return res.status(200).json({
      success: true,
      data: {
        status: BAG_STATUS.EXISTING_USER,
        bag: bagDetails,
        nfcToken,
        nfcTokenExpiresAt,
        maskedEmail: maskEmail(bag.user?.email || ''),
        username: bag.user?.username || null,
      },
      message: 'Bag is registered. Please log in to access your account.',
    });
  } catch (error) {
    logger.error(`handleScan error: ${error.message}`);
    next(error);
  }
};

module.exports = { handleScan };
