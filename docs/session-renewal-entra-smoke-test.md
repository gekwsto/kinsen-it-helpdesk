# Session renewal: Microsoft Entra ID smoke test

**Status: pending release acceptance check.** The Microsoft Entra path has
only been verified with mocks: route-level tests confirm the provider, the
`login_hint` and the return URL, and unit tests cover the identity binding.
The local environment has placeholder Entra credentials, so the real
Microsoft round trip has **not** been exercised. Run this procedure in a
non-production environment with real Entra configuration before release.
Nothing below changes production configuration.

## What is being verified

The application session is an absolute 8 hours from a real sign-in.
"Συνέχεια εργασίας" renews it by re-authenticating in a popup:

1. `GET /auth/session-renew`. It requires a valid session, sets a 10-minute,
   single-use renewal marker naming the current user, and starts the
   existing Entra sign-in with `login_hint=<user email>`.
2. Microsoft redirects back to the existing callback,
   `/api/auth/callback/microsoft-entra-id`. No new redirect URI is needed.
3. The `signIn` callback accepts the sign-in only if it is the same user.
   Otherwise it redirects to `/auth/session-renewed?error=different_account`
   before any account linking or cookie change happens.
4. `/auth/session-renewed` announces the outcome to every open tab and
   closes the popup. Each tab re-reads `/api/auth/session` and accepts only
   the same user with a later expiry.

## Prerequisites

- A test or staging deployment with real Entra ID configuration. The
  `AUTH_MICROSOFT_ENTRA_ID_*` settings must be the same as production apart
  from the redirect host.
- Two Entra test accounts in the allowed domain: **A** is the tester and
  **B** is a different user. Both must be able to sign in to the
  application.
- A desktop browser with developer tools and a second browser profile.
  Popups must be allowed for the site, except in step 6.
- Optional: database read access, used in step 4.

**Seeing the expiry.** While signed in, open `/api/auth/session` and read
`user.absoluteSessionExpiresAt` (epoch milliseconds). That value is
authoritative; record it before and after each renewal.

**Triggering the warning without waiting 7h55m.** Step 1 can be done
directly: the same popup flow runs when `/auth/session-renew` is opened in a
second window. To see the real warning (step 2), sign in about 8 hours before
the test, for example at the start of the previous working day's shift in the
test environment. Do not shorten the session duration in configuration.

## Procedure

Record the observed result for every step.

| # | Steps | Expected result |
|---|---|---|
| 1 | Sign in as **A** with Microsoft. Note `absoluteSessionExpiresAt` (E0). Open `/auth/session-renew` in a new window. | The Microsoft sign-in opens pre-selected for **A**. With an active Entra session it completes without a prompt, or with a single account confirmation or MFA. The window shows "Η συνεδρία ανανεώθηκε" and closes, or can be closed. `/api/auth/session` then shows E1 ≈ now + 8h and E1 > E0. |
| 2 | With a session less than 5 minutes from expiry, open two tabs, one with a partly filled form (for example New Project). Click **Συνέχεια εργασίας** (several times quickly). | One popup opens. Repeated clicks only focus it. After sign-in the warning closes in **both** tabs, the form keeps its content, and E2 ≈ now + 8h. |
| 3 | After step 2, keep working past the original expiry E0. | No warning reappears and API actions succeed. The warning appears again 5 minutes before E2. |
| 4 | Start a renewal as **A**. In the Microsoft popup choose "Use another account" and sign in as **B**. | The popup shows "Η σύνδεση έγινε με διαφορετικό λογαριασμό…" and the app tab shows the same message. `/api/auth/session` is still **A** with the unchanged expiry. In the database, no `Account` row for B's Microsoft identity has `userId` = A. |
| 5 | Start a renewal, then close the Microsoft popup without signing in. | Nothing changes: the warning stays, the session is unchanged, and Continue opens a new popup. |
| 6 | Block popups for the site, then click Continue. | A message says the popup was blocked and offers "Σύνδεση ξανά σε αυτή την καρτέλα". That option warns about unsaved changes, signs in, and returns to the same page. |
| 7 | Start a renewal, then click **Αποσύνδεση τώρα** in the app tab. | The popup closes, every tab goes to `/login`, and the cookie `kinsen-session-renewal` is gone (developer tools → Application → Cookies). |
| 8 | Sign out of Microsoft only (at myaccount.microsoft.com), then renew as **A**. | Microsoft asks for credentials and MFA as normal. A successful sign-in renews the session as in step 1. |
| 9 | Let a session reach its expiry while a renewal popup is open. | At expiry the app signs out to `/login?message=session_expired` and the popup closes. Opening `/auth/session-renew` without a session redirects to `/login`. |
| 10 | Throughout steps 1–9, watch the popup and app URLs and the server access log. | No `AADSTS` errors (for example `AADSTS50011`, a redirect URI mismatch). No credentials or tokens appear in any URL. |

## Acceptance

Release once steps 1–10 match the expected results in the target
environment. Record the environment, the date, the tester and any deviations
in the release notes.
