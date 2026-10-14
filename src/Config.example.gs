/**
 * Copy this file to Config.gs and fill it in. Config.gs is gitignored.
 *
 * Nothing here is secret in the credential sense, but the folder ID points at
 * records about named people, so it does not belong in a public repository.
 */

var CONFIG = {

  /**
   * Google Drive folder holding the roster, snapshots and overrides.
   * Take it from the folder URL: drive.google.com/drive/folders/<THIS_PART>
   */
  FOLDER_ID: 'PUT_YOUR_DRIVE_FOLDER_ID_HERE',

  /**
   * Contact email sent to Crossref as the `mailto` parameter. This puts you in
   * their polite pool, which is faster and better behaved than anonymous use.
   * Not optional in spirit — identify yourself when crawling someone's API.
   */
  MAILTO: 'you@example.edu',

  /**
   * Matches your institution's name as publishers write it in affiliation
   * strings. Used as a weak corroboration signal when a student's paper has no
   * advisor on it.
   *
   * Keep it loose. Publishers write the full name, abbreviations, and
   * department-prefixed variants inconsistently. Expect this signal absent
   * far more often than present — in testing, the four students with the worst
   * name collisions had zero institution-tagged records between them across
   * 373 candidate papers.
   */
  INSTITUTION_RE: /your-institution/i,

  /** Title on the public web-app page. */
  PAGE_TITLE: 'PubWatch Index'
};
