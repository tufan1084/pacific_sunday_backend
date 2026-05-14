const iykService = require('../services/iykService');

// Verify NFC chip and get chip data
exports.verifyChip = async (req, res) => {
  try {
    const { e, c, d } = req.query;

    if (!e || !c || !d) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: e, c, d'
      });
    }

    const chipData = await iykService.findChip(e, c, d);

    res.status(200).json({
      success: true,
      data: chipData
    });

  } catch (error) {
    console.error('IYK verify chip error:', error);
    res.status(404).json({
      success: false,
      message: error.message || 'Chip not found'
    });
  }
};
