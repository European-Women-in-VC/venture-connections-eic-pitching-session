// Team members and access (owner / editor / viewer per product). Pure functions: panel + tests.
// Data comes from public.team_list() and public.my_access() (see migration 20261031090000_team_members_roles.sql).

export const PRODUCT = 'eic-bookings'; // this panel's product

export const MEMBER_STATUSES = {
  active: { label: 'Active', tone: 'green' },
  invited: { label: 'Not signed in yet', tone: 'amber' },
  disabled: { label: 'Disabled', tone: 'gray' },
};

export const ACCESS = {
  owner: { label: 'Owner', tone: 'violet', hint: 'Manages the team; can read and edit everything' },
  editor: { label: 'Editor', tone: 'blue', hint: 'Can read and edit' },
  viewer: { label: 'Viewer', tone: 'teal', hint: 'Can read, not edit' },
  none: { label: 'No access', tone: 'gray', hint: 'Can’t see this product' },
};

export function memberStatus(m) {
  if (m.disabledAt) return 'disabled';
  return m.lastSignInAt ? 'active' : 'invited';
}

export const memberAccess = (m, product) => (m.isOwner ? 'owner' : m.roles?.[product] || 'none');

export const canEditProduct = (access, product) =>
  Boolean(access?.products?.some((p) => p.slug === product && p.role === 'editor'));
