/**
 * This project uses Prisma ORM for all database models and queries.
 * The canonical schema is defined in prisma/schema.prisma.
 *
 * This file exports shared type constants used across the application
 * to avoid magic strings in business logic.
 */

/**
 * Possible statuses returned to the frontend after an NFC scan.
 */
const BAG_STATUS = Object.freeze({
  /** Bag has never been registered, or exists but has no linked user */
  NEW_USER: 'new_user',
  /** Bag exists and is linked to an existing user account */
  EXISTING_USER: 'existing_user',
});

module.exports = { BAG_STATUS };
