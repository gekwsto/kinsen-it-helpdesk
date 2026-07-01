import { PrismaClient, Role, AuthProvider, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ─── Permissions definition ───────────────────────────────────────────────────

const PERMISSIONS = [
  // Activities
  { key: "activity.view", description: "View activities", module: "activities" },
  { key: "activity.create", description: "Create activities", module: "activities" },
  { key: "activity.edit", description: "Edit activities", module: "activities" },
  { key: "activity.delete", description: "Delete activities", module: "activities" },
  { key: "activity.assign", description: "Assign activities to users", module: "activities" },
  // Projects
  { key: "project.view", description: "View projects", module: "projects" },
  { key: "project.create", description: "Create projects", module: "projects" },
  { key: "project.edit", description: "Edit projects", module: "projects" },
  { key: "project.delete", description: "Delete projects", module: "projects" },
  // Goals
  { key: "goal.view", description: "View yearly goals", module: "goals" },
  { key: "goal.create", description: "Create yearly goals", module: "goals" },
  { key: "goal.edit", description: "Edit yearly goals", module: "goals" },
  { key: "goal.delete", description: "Delete yearly goals", module: "goals" },
  // Tickets
  { key: "ticket.view", description: "View tickets", module: "tickets" },
  { key: "ticket.create", description: "Create tickets", module: "tickets" },
  { key: "ticket.reply", description: "Reply to tickets", module: "tickets" },
  { key: "ticket.internalNote", description: "Add internal notes", module: "tickets" },
  { key: "ticket.assign", description: "Assign tickets to agents", module: "tickets" },
  { key: "ticket.changeStatus", description: "Change ticket status", module: "tickets" },
  // Admin
  { key: "admin.access", description: "Access admin panel", module: "admin" },
  { key: "user.manage", description: "Manage users", module: "admin" },
  { key: "role.manage", description: "Manage roles and permissions", module: "admin" },
];

// Permissions per role (ADMIN gets all via code shortcut)
const ROLE_PERMISSIONS: Record<string, string[]> = {
  IT_AGENT: [
    "activity.view", "activity.create", "activity.edit", "activity.assign",
    "project.view", "project.create", "project.edit",
    "goal.view",
    "ticket.view", "ticket.create", "ticket.reply",
    "ticket.internalNote", "ticket.assign", "ticket.changeStatus",
  ],
  DEPARTMENT_MANAGER: [
    "activity.view", "activity.create", "activity.edit", "activity.assign",
    "project.view", "project.create", "project.edit",
    "goal.view", "goal.create", "goal.edit",
    "ticket.view", "ticket.create", "ticket.reply",
  ],
  USER: [
    "activity.view",
    "ticket.view", "ticket.create", "ticket.reply",
  ],
};

async function main() {
  console.log("Seeding database...");

  // Ticket Statuses
  const statuses = [
    { name: "Open", color: "#3b82f6", isDefault: true, isClosed: false, order: 1 },
    { name: "In Progress", color: "#f59e0b", isDefault: false, isClosed: false, order: 2 },
    { name: "Pending User", color: "#8b5cf6", isDefault: false, isClosed: false, order: 3 },
    { name: "Resolved", color: "#10b981", isDefault: false, isClosed: false, order: 4 },
    { name: "Closed", color: "#6b7280", isDefault: false, isClosed: true, order: 5 },
    { name: "Cancelled", color: "#ef4444", isDefault: false, isClosed: true, order: 6 },
  ];

  for (const status of statuses) {
    await prisma.ticketStatus.upsert({
      where: { name: status.name },
      update: {},
      create: status,
    });
  }
  console.log("✓ Ticket statuses seeded");

  // Ticket Priorities (Critical removed — mapped to High for existing data)
  const priorities = [
    { name: "High", level: 3, color: "#f97316" },
    { name: "Medium", level: 2, color: "#f59e0b" },
    { name: "Low", level: 1, color: "#22c55e" },
  ];

  for (const priority of priorities) {
    await prisma.ticketPriority.upsert({
      where: { name: priority.name },
      update: {},
      create: priority,
    });
  }
  console.log("✓ Ticket priorities seeded");

  // Ticket Categories
  const categories = [
    { name: "Hardware", description: "Physical device issues", color: "#6366f1" },
    { name: "Software", description: "Application or OS issues", color: "#8b5cf6" },
    { name: "Network", description: "Connectivity and network issues", color: "#06b6d4" },
    { name: "Access & Permissions", description: "Login, permissions, account issues", color: "#14b8a6" },
    { name: "Email", description: "Email client and server issues", color: "#f59e0b" },
    { name: "Printing", description: "Printer and printing issues", color: "#f97316" },
    { name: "Security", description: "Security incidents and concerns", color: "#ef4444" },
    { name: "General IT", description: "General IT support requests", color: "#6b7280" },
  ];

  for (const category of categories) {
    await prisma.ticketCategory.upsert({
      where: { name: category.name },
      update: {},
      create: category,
    });
  }
  console.log("✓ Ticket categories seeded");

  // Cancel Reasons
  const cancelReasons = [
    { name: "Duplicate", description: "Ticket is a duplicate of another" },
    { name: "User Request", description: "User requested cancellation" },
    { name: "Not an IT Issue", description: "Issue is outside IT scope" },
    { name: "Resolved by User", description: "User resolved the issue themselves" },
    { name: "Test Ticket", description: "Ticket was created for testing purposes" },
  ];

  for (const reason of cancelReasons) {
    await prisma.ticketCancelReason.upsert({
      where: { name: reason.name },
      update: {},
      create: reason,
    });
  }
  console.log("✓ Cancel reasons seeded");

  // Company
  const company = await prisma.company.upsert({
    where: { domain: "kinsen.gr" },
    update: {},
    create: {
      name: "Kinsen",
      domain: "kinsen.gr",
    },
  });
  console.log("✓ Company seeded");

  // Default Business Unit
  const defaultBU = await prisma.businessUnit.upsert({
    where: { id: "bu-default" },
    update: {},
    create: {
      id: "bu-default",
      name: "Information Technology",
      companyId: company.id,
    },
  });

  // Default Departments
  const departments = [
    { id: "dept-it", name: "IT Department" },
    { id: "dept-hr", name: "Human Resources" },
    { id: "dept-finance", name: "Finance" },
    { id: "dept-sales", name: "Sales" },
    { id: "dept-operations", name: "Operations" },
  ];

  for (const dept of departments) {
    await prisma.department.upsert({
      where: { id: dept.id },
      update: {},
      create: {
        ...dept,
        businessUnitId: defaultBU.id,
      },
    });
  }
  console.log("✓ Departments seeded");

  // ─── Users ────────────────────────────────────────────────────────────────────

  const adminPasswordHash = await bcrypt.hash(
    process.env.ADMIN_PASSWORD || "Kinsen123!",
    12
  );
  await prisma.user.upsert({
    where: { email: "admin@kinsen.gr" },
    update: {},
    create: {
      email: "admin@kinsen.gr",
      name: "System Administrator",
      role: Role.ADMIN,
      isActive: true,
      passwordHash: adminPasswordHash,
      authProvider: AuthProvider.CREDENTIALS,
      mustChangePassword: false,
    },
  });
  console.log("✓ Admin user seeded (admin@kinsen.gr)");

  const agentPasswordHash = await bcrypt.hash(
    process.env.DEMO_AGENT_PASSWORD || "Agent@123456",
    12
  );
  await prisma.user.upsert({
    where: { email: "agent@kinsen.gr" },
    update: {},
    create: {
      email: "agent@kinsen.gr",
      name: "Demo IT Agent",
      role: Role.IT_AGENT,
      isActive: true,
      passwordHash: agentPasswordHash,
      authProvider: AuthProvider.CREDENTIALS,
      mustChangePassword: false,
      departmentId: "dept-it",
    },
  });
  console.log("✓ IT Agent seeded (agent@kinsen.gr)");

  const managerPasswordHash = await bcrypt.hash(
    process.env.DEMO_MANAGER_PASSWORD || "Manager@123456",
    12
  );
  await prisma.user.upsert({
    where: { email: "manager@kinsen.gr" },
    update: {},
    create: {
      email: "manager@kinsen.gr",
      name: "Demo Manager",
      role: Role.DEPARTMENT_MANAGER,
      isActive: true,
      passwordHash: managerPasswordHash,
      authProvider: AuthProvider.CREDENTIALS,
      mustChangePassword: false,
      departmentId: "dept-hr",
    },
  });
  console.log("✓ Manager seeded (manager@kinsen.gr)");

  const userPasswordHash = await bcrypt.hash(
    process.env.DEMO_USER_PASSWORD || "User@123456",
    12
  );
  await prisma.user.upsert({
    where: { email: "user@kinsen.gr" },
    update: {},
    create: {
      email: "user@kinsen.gr",
      name: "Demo User",
      role: Role.USER,
      isActive: true,
      passwordHash: userPasswordHash,
      authProvider: AuthProvider.CREDENTIALS,
      mustChangePassword: false,
    },
  });
  console.log("✓ Demo user seeded (user@kinsen.gr)");

  const user2PasswordHash = await bcrypt.hash(
    process.env.DEMO_USER2_PASSWORD || "User2@123456",
    12
  );
  await prisma.user.upsert({
    where: { email: "user2@kinsen.gr" },
    update: {},
    create: {
      email: "user2@kinsen.gr",
      name: "Demo User 2",
      role: Role.USER,
      isActive: true,
      passwordHash: user2PasswordHash,
      authProvider: AuthProvider.CREDENTIALS,
      mustChangePassword: false,
    },
  });
  console.log("✓ Demo user 2 seeded (user2@kinsen.gr)");

  // ─── Permissions ──────────────────────────────────────────────────────────────

  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: { description: perm.description, module: perm.module },
      create: perm,
    });
  }
  console.log("✓ Permissions seeded");

  // ─── Role-Permission Mappings ─────────────────────────────────────────────────

  for (const [roleKey, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permKey of permKeys) {
      const perm = await prisma.permission.findUnique({ where: { key: permKey } });
      if (!perm) continue;
      await prisma.rolePermission.upsert({
        where: { roleKey_permissionId: { roleKey, permissionId: perm.id } },
        update: {},
        create: { roleKey, permissionId: perm.id },
      });
    }
  }
  console.log("✓ Role-permission mappings seeded");

  // ─── Built-in Custom Roles ────────────────────────────────────────────────────

  const builtInRoles = [
    { key: "ADMIN", name: "Administrator", description: "Full access to all features", isBuiltIn: true },
    { key: "IT_AGENT", name: "IT Agent", description: "Manage tickets, projects and activities", isBuiltIn: true },
    { key: "DEPARTMENT_MANAGER", name: "Department Manager", description: "Manage department projects and goals", isBuiltIn: true },
    { key: "USER", name: "User", description: "Submit and view own tickets", isBuiltIn: true },
  ];

  for (const role of builtInRoles) {
    await prisma.customRole.upsert({
      where: { key: role.key },
      update: { name: role.name, description: role.description },
      create: role,
    });
  }
  console.log("✓ Built-in custom roles seeded");

  // ─── Mock Data ────────────────────────────────────────────────────────────────

  const [
    adminUser, agentUser, managerUser, demoUser,
    openStatus, inProgressStatus, pendingStatus, resolvedStatus, closedStatus,
    highPri, mediumPri, lowPri,
    hardwareCat, softwareCat, networkCat, accessCat, emailCat, printingCat, securityCat,
  ] = await Promise.all([
    prisma.user.findUnique({ where: { email: "admin@kinsen.gr" } }),
    prisma.user.findUnique({ where: { email: "agent@kinsen.gr" } }),
    prisma.user.findUnique({ where: { email: "manager@kinsen.gr" } }),
    prisma.user.findUnique({ where: { email: "user@kinsen.gr" } }),
    prisma.ticketStatus.findFirst({ where: { name: "Open" } }),
    prisma.ticketStatus.findFirst({ where: { name: "In Progress" } }),
    prisma.ticketStatus.findFirst({ where: { name: "Pending User" } }),
    prisma.ticketStatus.findFirst({ where: { name: "Resolved" } }),
    prisma.ticketStatus.findFirst({ where: { name: "Closed" } }),
    prisma.ticketPriority.findFirst({ where: { name: "High" } }),
    prisma.ticketPriority.findFirst({ where: { name: "Medium" } }),
    prisma.ticketPriority.findFirst({ where: { name: "Low" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Hardware" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Software" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Network" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Access & Permissions" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Email" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Printing" } }),
    prisma.ticketCategory.findFirst({ where: { name: "Security" } }),
  ]);

  if (!adminUser || !agentUser || !managerUser || !demoUser) {
    console.error("Users not found — skipping mock data");
    return;
  }
  if (!openStatus || !inProgressStatus || !pendingStatus || !resolvedStatus || !closedStatus) {
    console.error("Statuses not found — skipping mock data");
    return;
  }
  if (!highPri || !mediumPri || !lowPri) {
    console.error("Priorities not found — skipping mock data");
    return;
  }

  // Projects
  const proj1 = await prisma.project.upsert({
    where: { id: "mock-proj-001" },
    update: {},
    create: {
      id: "mock-proj-001",
      title: "IT Infrastructure Upgrade",
      description: "Complete overhaul of network switches, servers, and UPS systems across all floors.",
      status: ProjectStatus.IN_PROGRESS,
      priority: 3,
      ownerId: adminUser.id,
      departmentId: "dept-it",
      businessUnitId: "bu-default",
      startDate: new Date("2026-03-01"),
      endDate: new Date("2026-09-30"),
      successTarget: "All network switches replaced, server room reorganised, 99.9% uptime maintained.",
      members: { connect: [{ id: adminUser.id }] },
    },
  });

  const proj2 = await prisma.project.upsert({
    where: { id: "mock-proj-002" },
    update: {},
    create: {
      id: "mock-proj-002",
      title: "Office 365 Migration",
      description: "Migrate all on-premises Exchange mailboxes and SharePoint data to Office 365.",
      status: ProjectStatus.PLANNING,
      priority: 3,
      ownerId: adminUser.id,
      departmentId: "dept-it",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-12-31"),
      members: { connect: [{ id: adminUser.id }] },
    },
  });

  const proj3 = await prisma.project.upsert({
    where: { id: "mock-proj-003" },
    update: {},
    create: {
      id: "mock-proj-003",
      title: "Security Audit 2026",
      description: "Annual comprehensive security audit covering vulnerabilities, password policies, and access reviews.",
      status: ProjectStatus.IN_PROGRESS,
      priority: 3,
      ownerId: adminUser.id,
      departmentId: "dept-it",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-07-31"),
      successTarget: "Zero critical vulnerabilities unmitigated at project close.",
    },
  });

  const proj4 = await prisma.project.upsert({
    where: { id: "mock-proj-004" },
    update: {},
    create: {
      id: "mock-proj-004",
      title: "New Employee Onboarding System",
      description: "Build a self-service portal for IT onboarding — account creation, hardware requests, software provisioning.",
      status: ProjectStatus.COMPLETED,
      priority: 2,
      ownerId: adminUser.id,
      departmentId: "dept-hr",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-04-30"),
    },
  });

  console.log("✓ Projects seeded");

  // Activities
  const act1 = await prisma.projectActivity.upsert({
    where: { id: "mock-act-001" },
    update: {},
    create: {
      id: "mock-act-001",
      title: "Network Switch Replacement",
      description: "Replace all Cat5 switches on floors 1–3 with new Cat6A managed switches.",
      status: ActivityStatus.IN_PROGRESS,
      priority: ActivityPriority.URGENT,
      projectId: proj1.id,
      assignedUserId: agentUser.id,
      createdById: adminUser.id,
      startDate: new Date("2026-04-01"),
      dueDate: new Date("2026-06-30"),
    },
  });

  const act2 = await prisma.projectActivity.upsert({
    where: { id: "mock-act-002" },
    update: {},
    create: {
      id: "mock-act-002",
      title: "Server Room Cleanup",
      description: "Decommission end-of-life servers, label all cables, update rack diagrams.",
      status: ActivityStatus.TODO,
      priority: ActivityPriority.MEDIUM,
      projectId: proj1.id,
      assignedUserId: agentUser.id,
      createdById: adminUser.id,
      startDate: new Date("2026-07-01"),
      dueDate: new Date("2026-08-15"),
    },
  });

  await prisma.projectActivity.upsert({
    where: { id: "mock-act-003" },
    update: {},
    create: {
      id: "mock-act-003",
      title: "UPS Battery Check",
      description: "Test and replace UPS batteries in server room and on each floor.",
      status: ActivityStatus.COMPLETED,
      priority: ActivityPriority.HIGH,
      projectId: proj1.id,
      assignedUserId: agentUser.id,
      createdById: adminUser.id,
      isCompleted: true,
      completedAt: new Date("2026-05-10"),
    },
  });

  const act4 = await prisma.projectActivity.upsert({
    where: { id: "mock-act-004" },
    update: {},
    create: {
      id: "mock-act-004",
      title: "License Audit",
      description: "Audit existing Office 365 licenses, identify unused seats, and optimise the subscription.",
      status: ActivityStatus.TODO,
      priority: ActivityPriority.MEDIUM,
      projectId: proj2.id,
      assignedUserId: agentUser.id,
      createdById: agentUser.id,
      dueDate: new Date("2026-08-01"),
    },
  });

  const act5 = await prisma.projectActivity.upsert({
    where: { id: "mock-act-005" },
    update: {},
    create: {
      id: "mock-act-005",
      title: "Email Migration Planning",
      description: "Define migration batches, create rollback plan, schedule maintenance windows.",
      status: ActivityStatus.IN_PROGRESS,
      priority: ActivityPriority.HIGH,
      projectId: proj2.id,
      assignedUserId: adminUser.id,
      createdById: agentUser.id,
      startDate: new Date("2026-07-01"),
      dueDate: new Date("2026-08-31"),
    },
  });

  const act6 = await prisma.projectActivity.upsert({
    where: { id: "mock-act-006" },
    update: {},
    create: {
      id: "mock-act-006",
      title: "Vulnerability Scan",
      description: "Run full network and application vulnerability scan using Nessus.",
      status: ActivityStatus.IN_PROGRESS,
      priority: ActivityPriority.URGENT,
      projectId: proj3.id,
      assignedUserId: agentUser.id,
      createdById: adminUser.id,
      startDate: new Date("2026-05-05"),
      dueDate: new Date("2026-06-15"),
    },
  });

  const act7 = await prisma.projectActivity.upsert({
    where: { id: "mock-act-007" },
    update: {},
    create: {
      id: "mock-act-007",
      title: "Password Policy Review",
      description: "Review and update password complexity requirements across all systems.",
      status: ActivityStatus.TODO,
      priority: ActivityPriority.HIGH,
      projectId: proj3.id,
      assignedUserId: agentUser.id,
      createdById: adminUser.id,
      dueDate: new Date("2026-07-01"),
    },
  });

  await prisma.projectActivity.upsert({
    where: { id: "mock-act-008" },
    update: {},
    create: {
      id: "mock-act-008",
      title: "Onboarding Portal Design",
      description: "Design and implement the self-service onboarding portal UI.",
      status: ActivityStatus.COMPLETED,
      priority: ActivityPriority.HIGH,
      projectId: proj4.id,
      assignedUserId: agentUser.id,
      createdById: managerUser.id,
      isCompleted: true,
      completedAt: new Date("2026-04-15"),
    },
  });

  // Standalone activities (no project)
  await prisma.projectActivity.upsert({
    where: { id: "mock-act-009" },
    update: {},
    create: {
      id: "mock-act-009",
      title: "Weekly IT Maintenance",
      description: "Routine weekly maintenance: patch updates, log reviews, backup checks.",
      status: ActivityStatus.IN_PROGRESS,
      priority: ActivityPriority.LOW,
      assignedUserId: agentUser.id,
      createdById: agentUser.id,
    },
  });

  await prisma.projectActivity.upsert({
    where: { id: "mock-act-010" },
    update: {},
    create: {
      id: "mock-act-010",
      title: "Software License Renewal",
      description: "Renew annual software licenses: Antivirus, Adobe, and monitoring tools.",
      status: ActivityStatus.TODO,
      priority: ActivityPriority.MEDIUM,
      assignedUserId: agentUser.id,
      createdById: adminUser.id,
      dueDate: new Date("2026-08-31"),
    },
  });

  console.log("✓ Activities seeded");

  // Helper function: upsert ticket
  async function upsertTicket(id: string, data: {
    title: string;
    description: string;
    statusId: string;
    requesterId: string;
    categoryId?: string | null;
    priorityId?: string | null;
    assignedAgentId?: string | null;
    departmentId?: string | null;
    projectId?: string | null;
    activityId?: string | null;
    source?: "WEB" | "EMAIL";
    messages?: Array<{ body: string; authorId: string; isInternal?: boolean }>;
  }) {
    const ticket = await prisma.ticket.upsert({
      where: { id },
      update: {},
      create: {
        id,
        title: data.title,
        description: data.description,
        source: data.source ?? "WEB",
        statusId: data.statusId,
        requesterId: data.requesterId,
        categoryId: data.categoryId,
        priorityId: data.priorityId,
        assignedAgentId: data.assignedAgentId,
        departmentId: data.departmentId,
        projectId: data.projectId,
        activityId: data.activityId,
      },
    });
    if (data.messages) {
      for (const msg of data.messages) {
        const existing = await prisma.ticketMessage.count({ where: { ticketId: ticket.id, authorId: msg.authorId, body: msg.body } });
        if (!existing) {
          await prisma.ticketMessage.create({
            data: {
              ticketId: ticket.id,
              authorId: msg.authorId,
              body: msg.body,
              direction: msg.isInternal ? "INTERNAL_NOTE" : "OUTBOUND",
              isInternal: msg.isInternal ?? false,
            },
          });
        }
      }
    }
    return ticket;
  }

  // Tickets — standalone (no project/activity)
  await upsertTicket("mock-tkt-001", {
    title: "Laptop won't start after Windows update",
    description: "My laptop stopped booting after the latest Windows update was applied. Stuck on a black screen with spinning dots. This is my primary work machine.",
    statusId: openStatus.id,
    requesterId: demoUser.id,
    categoryId: hardwareCat?.id,
    priorityId: highPri.id,
    departmentId: "dept-finance",
    messages: [
      { body: "I've tried holding the power button for 10 seconds. Still no display. Power LED is on.", authorId: demoUser.id },
      { body: "Received your ticket. We'll have an agent with you within the hour. Please don't attempt further restarts.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-002", {
    title: "Cannot access shared Finance drive",
    description: "Since this morning I've lost access to the \\\\fileserver\\Finance shared drive. My permissions haven't changed as far as I know. Getting 'Access Denied' error.",
    statusId: inProgressStatus.id,
    requesterId: managerUser.id,
    categoryId: accessCat?.id,
    priorityId: highPri.id,
    assignedAgentId: agentUser.id,
    departmentId: "dept-finance",
    messages: [
      { body: "Investigating. Looks like a group policy pushed overnight may have reset your AD group membership.", authorId: agentUser.id },
      { body: "Thank you — how long will this take to fix?", authorId: managerUser.id },
    ],
  });

  await upsertTicket("mock-tkt-003", {
    title: "Outlook keeps crashing on send",
    description: "Outlook crashes every time I try to send an email with an attachment over 5MB. Happened 4 times today. Running Office 2021 on Windows 11.",
    statusId: pendingStatus.id,
    requesterId: demoUser.id,
    categoryId: emailCat?.id,
    priorityId: mediumPri.id,
    assignedAgentId: agentUser.id,
    departmentId: "dept-hr",
    messages: [
      { body: "Applied the latest Office patch (KB5002475). Please confirm if the issue persists after restarting Outlook.", authorId: agentUser.id },
      { body: "Restarted, will monitor. Will reply by end of day.", authorId: demoUser.id },
    ],
  });

  await upsertTicket("mock-tkt-010", {
    title: "HP printer on Finance floor not printing",
    description: "The HP LaserJet on the 2nd floor Finance area is showing 'Paper Jam' but the paper tray is clear. Colleagues can't print urgent documents.",
    statusId: openStatus.id,
    requesterId: demoUser.id,
    categoryId: printingCat?.id,
    priorityId: lowPri.id,
    departmentId: "dept-finance",
  });

  await upsertTicket("mock-tkt-011", {
    title: "VPN drops connection every 30 minutes",
    description: "The VPN disconnects exactly every 30 minutes when working from home. Affects all remote workers since the firewall update on Monday.",
    statusId: resolvedStatus.id,
    requesterId: managerUser.id,
    categoryId: networkCat?.id,
    priorityId: highPri.id,
    assignedAgentId: agentUser.id,
    messages: [
      { body: "Root cause: VPN idle timeout was incorrectly set to 1800s during the firewall update. Fixed and pushed. Please test.", authorId: agentUser.id },
      { body: "Working perfectly now. Thanks!", authorId: managerUser.id },
    ],
  });

  await upsertTicket("mock-tkt-012", {
    title: "Request: Adobe Acrobat Pro installation",
    description: "I need Adobe Acrobat Pro installed on my workstation (WIN-HR-042) for processing contract PDFs. I have manager approval.",
    statusId: closedStatus.id,
    requesterId: demoUser.id,
    categoryId: softwareCat?.id,
    priorityId: lowPri.id,
    assignedAgentId: agentUser.id,
    departmentId: "dept-hr",
    messages: [
      { body: "Approved and installed. License key registered under your email.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-015", {
    title: "USB mouse and keyboard not recognised",
    description: "After logging in this morning, neither my USB mouse nor keyboard respond. Tried different USB ports. Works fine on another PC.",
    statusId: openStatus.id,
    requesterId: demoUser.id,
    categoryId: hardwareCat?.id,
    priorityId: mediumPri.id,
    departmentId: "dept-sales",
  });

  await upsertTicket("mock-tkt-016", {
    title: "Outlook calendar not syncing with Teams",
    description: "My Outlook calendar events don't appear in Microsoft Teams. Started after the Office update last Thursday. Meetings are appearing in Outlook but not Teams calendar.",
    statusId: pendingStatus.id,
    requesterId: managerUser.id,
    categoryId: emailCat?.id,
    priorityId: lowPri.id,
    assignedAgentId: agentUser.id,
    departmentId: "dept-hr",
    messages: [
      { body: "Cleared the Teams cache and re-signed in. Please confirm if calendar events now appear in Teams.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-017", {
    title: "MFA setup assistance needed",
    description: "I tried to set up the Microsoft Authenticator for MFA but the QR code scan keeps failing. Need help setting it up before the MFA enforcement deadline.",
    statusId: openStatus.id,
    requesterId: demoUser.id,
    categoryId: accessCat?.id,
    priorityId: lowPri.id,
    departmentId: "dept-operations",
  });

  // Tickets linked directly to a project (no activity)
  await upsertTicket("mock-tkt-013", {
    title: "New workstation needed for infrastructure team",
    description: "The infrastructure upgrade project requires two additional workstations with 32GB RAM for the team members running the switch management software.",
    statusId: openStatus.id,
    requesterId: adminUser.id,
    categoryId: hardwareCat?.id,
    priorityId: mediumPri.id,
    assignedAgentId: agentUser.id,
    projectId: proj1.id,
    messages: [
      { body: "Checking stock and procurement timeline. Will confirm by EOD.", authorId: agentUser.id },
      { body: "Ordered. ETA 5–7 business days. Ticket → [Infrastructure Upgrade].", authorId: agentUser.id, isInternal: true },
    ],
  });

  await upsertTicket("mock-tkt-018", {
    title: "Network performance degradation on 3rd floor",
    description: "Since we started the switch replacement work, the 3rd floor is experiencing intermittent packet loss (>5%). Affects the call centre team.",
    statusId: inProgressStatus.id,
    requesterId: adminUser.id,
    categoryId: networkCat?.id,
    priorityId: highPri.id,
    assignedAgentId: agentUser.id,
    projectId: proj1.id,
    messages: [
      { body: "Isolated to the temporary VLAN trunk during migration. Adjusting trunk settings now.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-014", {
    title: "Onboarding portal login broken for new hires",
    description: "New employees onboarded since April 25 cannot log into the onboarding portal. The SSO callback URL appears to be pointing at the old dev server.",
    statusId: inProgressStatus.id,
    requesterId: managerUser.id,
    categoryId: softwareCat?.id,
    priorityId: highPri.id,
    assignedAgentId: agentUser.id,
    projectId: proj4.id,
    messages: [
      { body: "Reproduced. The production redirect URI was overwritten during the April 28 deploy. Rolling back the OAuth app config now.", authorId: agentUser.id },
      { body: "Fixed in production. Please have one of the affected users retry.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-019", {
    title: "Phishing email targeting Finance team",
    description: "Several Finance team members received a convincing phishing email appearing to come from our CEO requesting urgent wire transfer approval. 2 staff clicked the link.",
    statusId: inProgressStatus.id,
    requesterId: managerUser.id,
    categoryId: securityCat?.id,
    priorityId: highPri.id,
    assignedAgentId: adminUser.id,
    departmentId: "dept-finance",
    projectId: proj3.id,
    messages: [
      { body: "INTERNAL: Reset credentials for the 2 affected users. Blocked the phishing domain at DNS level. Running endpoint scan.", authorId: adminUser.id, isInternal: true },
      { body: "Immediate actions taken: passwords reset, domain blocked, affected machines isolated for scanning. We'll send a company-wide warning email.", authorId: adminUser.id },
    ],
  });

  // Tickets linked via activities (no direct projectId — tests the OR query)
  await upsertTicket("mock-tkt-004", {
    title: "Switch port configuration error on Floor 1",
    description: "After the new switch was installed on Floor 1, ports 12–16 are not passing traffic. Devices connected to these ports show link-up but no connectivity.",
    statusId: inProgressStatus.id,
    requesterId: demoUser.id,
    categoryId: networkCat?.id,
    priorityId: highPri.id,
    assignedAgentId: agentUser.id,
    activityId: act1.id, // activity belongs to proj1 — should appear in proj1 related tickets
    messages: [
      { body: "Ports 12–16 are missing the VLAN tag for the production network. Reconfiguring now.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-005", {
    title: "Old rack unit disposal — asbestos concern",
    description: "During the server room cleanup pre-work, a white fibrous material was found around one of the 1998-era rack units. Unsure if it's hazardous. Work has been paused.",
    statusId: openStatus.id,
    requesterId: agentUser.id,
    categoryId: hardwareCat?.id,
    priorityId: highPri.id,
    departmentId: "dept-it",
    activityId: act2.id, // activity belongs to proj1
  });

  await upsertTicket("mock-tkt-006", {
    title: "O365 license count mismatch in admin portal",
    description: "The Office 365 admin portal shows 147 assigned licenses but our HR system shows only 131 active employees. The audit needs to resolve 16 unaccounted licenses.",
    statusId: openStatus.id,
    requesterId: managerUser.id,
    categoryId: softwareCat?.id,
    priorityId: mediumPri.id,
    assignedAgentId: agentUser.id,
    activityId: act4.id, // activity belongs to proj2
  });

  await upsertTicket("mock-tkt-007", {
    title: "Test mailbox migration failed for user.test@kinsen.gr",
    description: "The pilot migration of the test mailbox failed at 67% with error: MigrationPermanentException — mailbox size limit exceeded. Blocking the planning activity.",
    statusId: inProgressStatus.id,
    requesterId: agentUser.id,
    categoryId: emailCat?.id,
    priorityId: highPri.id,
    assignedAgentId: adminUser.id,
    activityId: act5.id, // activity belongs to proj2
    messages: [
      { body: "The source mailbox is 48GB, exceeding the 50GB limit with archive included. We'll need to archive old items first. ETA 2 days.", authorId: adminUser.id },
    ],
  });

  await upsertTicket("mock-tkt-008", {
    title: "Nessus scan blocking production traffic",
    description: "The vulnerability scan started this morning is causing packet loss on the production VLAN. Three critical business applications are affected. Need immediate decision on pause/continue.",
    statusId: openStatus.id,
    requesterId: adminUser.id,
    categoryId: securityCat?.id,
    priorityId: highPri.id,
    assignedAgentId: agentUser.id,
    activityId: act6.id, // activity belongs to proj3
    messages: [
      { body: "Paused the scan on production VLAN. Continuing on DMZ only until off-hours.", authorId: agentUser.id },
    ],
  });

  await upsertTicket("mock-tkt-009", {
    title: "Password complexity policy blocking shared service accounts",
    description: "Applying the new password complexity policy via GPO is forcing service accounts to change their passwords at next login. This breaks 4 automated processes. Need an exclusion.",
    statusId: inProgressStatus.id,
    requesterId: agentUser.id,
    categoryId: accessCat?.id,
    priorityId: highPri.id,
    assignedAgentId: adminUser.id,
    activityId: act7.id, // activity belongs to proj3
    messages: [
      { body: "Created a separate OU for service accounts with a password-never-expires exception. Moving accounts now.", authorId: adminUser.id },
      { body: "INTERNAL: Service accounts excluded from the policy GPO. Activity can proceed.", authorId: adminUser.id, isInternal: true },
    ],
  });

  await upsertTicket("mock-tkt-020", {
    title: "License audit: Adobe licenses not reflected in O365 portal",
    description: "During the license audit, we found that 8 Adobe Creative Cloud licenses purchased via the O365 agreement do not appear in the M365 admin portal. Need to reconcile.",
    statusId: openStatus.id,
    requesterId: managerUser.id,
    categoryId: softwareCat?.id,
    priorityId: mediumPri.id,
    assignedAgentId: agentUser.id,
    activityId: act4.id, // same activity as tkt-006, also belongs to proj2
  });

  // Email-sourced ticket
  await upsertTicket("mock-tkt-email-001", {
    title: "Request for laptop replacement — sent via email",
    description: "My current laptop (HP EliteBook 840 G5, 2018) is running very slowly. I've submitted this request via email as per the IT instructions on the intranet.",
    statusId: openStatus.id,
    requesterId: demoUser.id,
    categoryId: hardwareCat?.id,
    priorityId: mediumPri.id,
    source: "EMAIL",
    messages: [
      { body: "Thank you for your request. We'll assess your current hardware and get back to you within 3 business days.", authorId: agentUser.id },
    ],
  });

  console.log("✓ Mock tickets and messages seeded");
  console.log("\n✅ Database seeded successfully!");
  console.log("\nDemo accounts:");
  console.log("  admin@kinsen.gr       / Admin@123456   (Administrator)");
  console.log("  agent@kinsen.gr       / Agent@123456   (IT Agent)");
  console.log("  manager@kinsen.gr     / Manager@123456 (Dept. Manager)");
  console.log("  user@kinsen.gr        / User@123456    (User — has tickets)");
  console.log("  user2@kinsen.gr       / User2@123456   (User — no tickets)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
