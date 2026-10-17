import { safeReturnTo } from './auth.controller.js';

describe('safeReturnTo', () => {
  it('keeps paths inside the web app', () => {
    expect(safeReturnTo('/grown-ups')).toBe('/grown-ups');
    expect(safeReturnTo('/grown-ups?tab=account')).toBe('/grown-ups?tab=account');
  });

  it('falls back for anything that could leave the site', () => {
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', 'grown-ups', '', undefined, 42, `/${'a'.repeat(300)}`]) {
      expect(safeReturnTo(value)).toBe('/grown-ups');
    }
  });
});
