import type { ReactNode } from "react";

const SERVICE_ACCOUNT = "tracker@project-tracker-513910.iam.gserviceaccount.com";

function Url({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[var(--brand-text)] underline">
      {href.replace("https://", "")}
    </a>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <h3 className="font-medium">{title}</h3>
      <div className="mt-1 space-y-1 text-neutral-600 dark:text-neutral-400">{children}</div>
    </li>
  );
}

function Copyable({ children }: { children: string }) {
  return (
    <code className="block w-fit max-w-full select-all break-all rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
      {children}
    </code>
  );
}

export function AnalyticsGuide() {
  return (
    <details className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <summary className="cursor-pointer text-sm font-semibold">How to add a new project</summary>
      <ol className="mt-4 list-decimal space-y-4 pl-5 text-sm">
        <Step title="Create the Google property">
          <p>
            Go to <Url href="https://analytics.google.com" /> and click Admin (the gear, bottom left).
          </p>
          <p>Check the account at the top left is Carl Projects, not Outer Join.</p>
          <p>Click Create, then Property. Enter the project name, South Africa and South African Rand.</p>
          <p>Fill in the next screens, then click Create and accept the terms if asked.</p>
        </Step>
        <Step title="Add the website and copy the G- ID">
          <p>Choose Web. Enter the site address and a name, then click Create stream.</p>
          <p>Copy the Measurement ID. It starts with G-. Do not use an ID that starts with GTM-.</p>
          <p>Close any screen that tells you to install a tag.</p>
        </Step>
        <Step title="Copy the Property ID">
          <p>Go to Admin, then Property details, and copy the Property ID. It is digits only.</p>
        </Step>
        <Step title="Let this tracker read the property">
          <p>Go to Admin, then Property access management.</p>
          <p>Click the blue +, then Add users. Paste this email:</p>
          <Copyable>{SERVICE_ACCOUNT}</Copyable>
          <p>Choose Viewer, untick Notify new users by email, and click Add.</p>
        </Step>
        <Step title="Ask Claude to add it to the site">
          <p>Paste this into Claude Code, with the project name and your G- ID filled in:</p>
          <Copyable>
            Add Google Analytics to [project] with ID [G- ID]. Use the same cookie notice, tracked-pages list and privacy wording as Price my Prang PR #11.
          </Copyable>
          <p>
            Claude opens a PR for you to merge. For reference, the Price my Prang version is at{" "}
            <Url href="https://github.com/CarlofSaints/PriceMyPrang/pull/11" />.
          </p>
        </Step>
        <Step title="Add it on this page">
          <p>Use Add a project above: choose the project, paste the Property ID, and click Add project.</p>
          <p>If the project is not in the list, click Sync now on the Dashboard first.</p>
        </Step>
        <Step title="Check it is working">
          <p>
            Open the live site and click Accept on the cookie notice. In Google Analytics, open Reports, then
            Realtime. You should appear within a minute.
          </p>
          <p>
            This page shows figures from the next day. Only people who click Accept are counted. If a project
            shows a red error, send it to Claude.
          </p>
        </Step>
      </ol>
    </details>
  );
}
