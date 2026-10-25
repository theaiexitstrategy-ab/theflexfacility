// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// The site-level values the Fuel Agent needs that aren't per challenge.
// Everything about a challenge (dates, caps, reward, coach name, copy)
// lives on its fuel_challenges row. A new gym tenant copies this repo's
// pages and changes only this file plus its challenge rows.

const TENANT = {
  clientId: 'flex-facility',
  // www, not the apex: the apex 307-redirects to www.
  siteUrl: 'https://www.theflexfacility.com',
  fromEmail: 'info@theflexfacility.com',
  fromName: 'The Flex Facility',
  agentPath: '/fuel/agent',
};

module.exports = { TENANT };
