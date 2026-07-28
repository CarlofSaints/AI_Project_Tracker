import { prisma } from "@/lib/db";
import { OrganizationManager } from "@/components/organization-manager";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
  const organizations = await prisma.organization.findMany({
    orderBy: { name: "asc" },
    include: {
      parent: { select: { id: true, name: true } },
      _count: { select: { projectsAsClient: true, projectsAsEndCustomer: true } },
    },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients &amp; Customers</h1>
        <p className="mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          One list of organisations. Whether an organisation is a <em>client</em> or a{" "}
          <em>customer</em> is decided per project, so the same record can be an end customer on one
          project and the client on another — Snomaster under Atomic Marketing, and Snomaster direct.
        </p>
      </div>

      <OrganizationManager organizations={organizations} />
    </div>
  );
}
