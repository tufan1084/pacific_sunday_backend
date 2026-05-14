const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { updateLiveLeaderboardInterval } = require('../services/golfCronService');

exports.getGolfSettings = async (req, res) => {
  try {
    let settings = await prisma.golfSettings.findFirst();
    if (!settings) {
      settings = await prisma.golfSettings.create({
        data: { leaderboardSyncInterval: 15, enabled: true }
      });
    }
    res.json({ success: true, data: settings });
  } catch (error) {
    logger.error(`getGolfSettings error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateGolfSettings = async (req, res) => {
  try {
    const { leaderboardSyncInterval, enabled } = req.body;
    
    let settings = await prisma.golfSettings.findFirst();
    
    const data = {};
    if (leaderboardSyncInterval !== undefined) {
      const interval = Number(leaderboardSyncInterval);
      if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
        return res.status(400).json({ 
          success: false, 
          message: 'Interval must be between 1 and 60 minutes' 
        });
      }
      data.leaderboardSyncInterval = interval;
    }
    if (enabled !== undefined) {
      data.enabled = Boolean(enabled);
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }

    if (settings) {
      settings = await prisma.golfSettings.update({
        where: { id: settings.id },
        data
      });
    } else {
      settings = await prisma.golfSettings.create({ data });
    }

    await updateLiveLeaderboardInterval();
    
    logger.info(`Golf settings updated: ${JSON.stringify(data)}`);
    res.json({ 
      success: true, 
      data: settings,
      message: 'Golf settings saved and cron job updated successfully'
    });
  } catch (error) {
    logger.error(`updateGolfSettings error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};
