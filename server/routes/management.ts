import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { pathParams, sendError, type ApiRequest, type ApiResponse, type UserRecord, type UserRole } from "../lib/http";

type Role = UserRole;

const money = (value: unknown) => Number(Number(value ?? 0).toFixed(2));

function cacheBustedImageUrl(url: string | null | undefined, version: unknown) {
  if (!url) return url;
  const stamp = version instanceof Date ? version.getTime() : new Date(String(version ?? "")).getTime();
  return Number.isFinite(stamp) ? `${url}${url.includes("?") ? "&" : "?"}v=${stamp}` : url;
}

const loginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});
const guardRegistrationSchema = z.object({
  name: z.string().trim().min(1),
  phoneNumber: z.string().trim().regex(/^\d{10}$/, "Phone number must contain 10 digits."),
  email: z.string().trim().email().optional().or(z.literal("")),
  age: z.coerce.number().int().min(18).max(100),
  companyCode: z.string().trim().toUpperCase().min(1),
  password: z.string().min(8),
});
const guardEmployeeRegistrationSchema = z.object({
  name: z.string().trim().min(1),
  phoneNumber: z.string().trim().regex(/^\d{10}$/, "Phone number must contain 10 digits."),
  email: z.string().trim().email().optional().or(z.literal("")),
  age: z.coerce.number().int().min(18).max(100),
  password: z.string().min(8),
  site: z.string().trim().optional(),
  basicSalary: z.number().finite().nonnegative().optional(),
});
const supervisorEmployeeRegistrationSchema = z.object({
  name: z.string().trim().min(1),
  phoneNumber: z.string().trim().regex(/^\d{10}$/, "Phone number must contain 10 digits."),
  email: z.string().trim().email().optional().or(z.literal("")),
  password: z.string().min(8),
});
const profileUpdateSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional().or(z.literal("")),
  mobileNumber: z.string().trim().max(30).nullish(),
  profilePictureUrl: z.string().url().nullish(),
});
const passwordUpdateSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
const documentSchema = z.object({ imageUrl: z.string().url() });
const companySchema = z.object({
  name: z.string().trim().min(1),
  logoUrl: z.string().trim().nullish(),
  gst: z.string().trim().optional(),
  accountNo: z.string().trim().optional(),
  officeNumber: z.string().trim().optional(),
});
const employeeSchema = z.object({
  name: z.string().trim().min(1),
  contact: z.string().trim().regex(/^\d{10}$/, "Phone number must be exactly 10 digits."),
  email: z.string().trim().email().nullish().or(z.literal("")),
  salary: z.number().finite().nonnegative(),
  site: z.string().trim().min(1),
  role: z.enum(["Security Guard", "Supervisor"]),
  basicSalary: z.number().finite().nonnegative(),
  allowances: z.number().finite().nonnegative(),
  overtime: z.number().finite().nonnegative(),
  pf: z.number().finite().nonnegative(),
  esic: z.number().finite().nonnegative(),
  profilePictureUrl: z.string().trim().nullish(),
  dateOfJoining: z
    .union([z.string().date(), z.string().datetime({ offset: true })])
    .transform((value) => value.slice(0, 10)),
});
const attendanceSchema = z.object({
  status: z.enum(["PRESENT", "ABSENT"]),
});
const salaryTransactionSchema = z.object({
  type: z.enum(["ADVANCE", "FINE"]),
  amount: z.number().finite().nonnegative(),
  note: z.string(),
  year: z.number().int().min(2020),
  month: z.number().int().min(1).max(12),
});
const salaryUpdateSchema = z.object({
  basicSalary: z.number().finite().nonnegative(),
  allowances: z.number().finite().nonnegative(),
  overtime: z.number().finite().nonnegative(),
  advance: z.number().finite().nonnegative(),
  fine: z.number().finite().nonnegative(),
  pf: z.number().finite().nonnegative(),
  esic: z.number().finite().nonnegative(),
  year: z.number().int().min(2020),
  month: z.number().int().min(1).max(12),
});
const monthYearSchema = z.object({
  year: z.coerce.number().int().min(2020).default(2026),
  month: z.coerce.number().int().min(1).max(12).default(6),
});
const accountSheetUpdateSchema = z.object({
  companyId: z.string().min(1),
  year: z.number().int().min(2020),
  month: z.number().int().min(1).max(12),
  totalBilling: z.number().finite(),
  totalReceiving: z.number().finite(),
  cashReceived: z.number().finite(),
  salary: z.number().finite(),
  expense: z.number().finite(),
  dressStock: z.number().finite(),
});

const COMPANY_CATALOG = {
  ISF: { id: "company-isf", name: "INDUSTRIAL SECURITY FORCE" },
  TIS: { id: "company-tis", name: "TARGET INDUSTRIAL SECURITY" },
  TSSM: { id: "company-tssm", name: "TARGET SECURITY SERVICE & MANPOWER" },
  TISF: { id: "company-tisf", name: "TARGET INDUSTRIAL SECURITY FORCE Pvt Ltd" },
  KE: { id: "company-ke", name: "KARNIKA ENTERPRISES" },
} as const;

function hashPassword(password: string) {
  const salt = "target-ops-development-salt";
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
type DuplicateKind = "mobile" | "email" | "both";

function normalizeMobileNumber(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}

function normalizeEmail(value: string | null | undefined) {
  const email = String(value ?? "").trim().toLowerCase();
  return email || null;
}

async function findDuplicateContact(
  db: Queryable,
  values: { mobileNumber?: string | null; email?: string | null; excludeUserId?: string; excludeEmployeeId?: string },
): Promise<DuplicateKind | null> {
  const mobile = normalizeMobileNumber(values.mobileNumber);
  const email = normalizeEmail(values.email);
  const userResult = await db.query(
    `SELECT mobile_number, email FROM users
     WHERE (($1::text IS NOT NULL AND mobile_number = $1)
        OR ($2::text IS NOT NULL AND lower(email) = $2))
       AND ($3::text IS NULL OR id <> $3)`,
    [mobile, email, values.excludeUserId ?? null],
  );
  const employeeResult = await db.query(
    `SELECT contact, email FROM employees
     WHERE deleted_at IS NULL
       AND (($1::text IS NOT NULL AND contact = $1) OR ($2::text IS NOT NULL AND lower(email) = $2))
       AND ($3::text IS NULL OR id <> $3)`,
    [mobile, email, values.excludeEmployeeId ?? null],
  );
  const mobileExists = userResult.rows.some((row: any) => row.mobile_number === mobile)
    || employeeResult.rows.some((row: any) => row.contact === mobile);
  const emailExists = Boolean(email) && (
    userResult.rows.some((row: any) => row.email?.toLowerCase() === email)
    || employeeResult.rows.some((row: any) => row.email?.toLowerCase() === email)
  );
  if (mobileExists && emailExists) return "both";
  if (mobileExists) return "mobile";
  if (emailExists) return "email";
  return null;
}

function sendDuplicateContactError(res: ApiResponse, duplicate: DuplicateKind) {
  const messages = {
    mobile: "Mobile number already exists. Please use a different mobile number.",
    email: "Email address already exists. Please use a different email.",
    both: "Mobile number and email address already exist. Please use different details.",
  };
  return sendError(res, 409, "CONTACT_ALREADY_EXISTS", messages[duplicate]);
}

function duplicateFromDatabaseError(error: unknown): DuplicateKind | null {
  const code = (error as { code?: string })?.code;
  const constraint = (error as { constraint?: string })?.constraint ?? "";
  if (code !== "23505") return null;
  if (constraint.includes("email")) return "email";
  if (constraint.includes("mobile") || constraint.includes("contact")) return "mobile";
  return "both";
}

function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

function imageKitUrlIsOwned(url: string) {
  const endpoint = process.env.IMAGEKIT_URL_ENDPOINT?.replace(/\/+$/, "");
  return Boolean(endpoint && url.startsWith(`${endpoint}/`));
}

async function deleteImageKitFile(url: string | null | undefined) {
  if (!url || !imageKitUrlIsOwned(url)) return;
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) throw new Error("ImageKit is not configured.");

  const searchQuery = `url = "${url.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const searchResponse = await fetch(
    `https://api.imagekit.io/v1/files?searchQuery=${encodeURIComponent(searchQuery)}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
      },
    },
  );
  if (!searchResponse.ok) {
    throw new Error(`ImageKit file lookup failed (HTTP ${searchResponse.status}).`);
  }
  const files = await searchResponse.json() as Array<{ fileId?: string; url?: string }>;
  const matches = files.filter((file) => file.fileId && file.url === url);
  if (!matches.length) {
    throw new Error("The ImageKit file could not be found.");
  }

  for (const file of matches) {
    const deleteResponse = await fetch(`https://api.imagekit.io/v1/files/${file.fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
      },
    });
    if (!deleteResponse.ok) {
      throw new Error(`ImageKit file deletion failed (HTTP ${deleteResponse.status}).`);
    }
  }
}

function imageKitFolderForEmployee(employeeId: number | string) {
  return `/employees/${String(employeeId)}`;
}

function imageKitFolderForCompany(companyId: string) {
  return `/company/${companyId}`;
}

async function deleteImageKitFolder(folderPath: string) {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) throw new Error("ImageKit is not configured.");

  const response = await fetch("https://api.imagekit.io/v1/folder", {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folderPath }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`ImageKit folder deletion failed (HTTP ${response.status}).`);
  }
}

async function createImageKitFolder(folderPath: string) {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) throw new Error("ImageKit is not configured.");

  const normalizedPath = folderPath.replace(/\/+$/, "");
  const separator = normalizedPath.lastIndexOf("/");
  const folderName = normalizedPath.slice(separator + 1);
  const parentFolderPath = normalizedPath.slice(0, separator) || "/";
  if (!folderName) throw new Error("An ImageKit folder name is required.");

  const response = await fetch("https://api.imagekit.io/v1/folder", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folderName, parentFolderPath }),
  });
  // A concurrent/retried request may have already recreated this empty folder.
  if (!response.ok && response.status !== 409) {
    throw new Error(`ImageKit folder creation failed (HTTP ${response.status}).`);
  }
}

async function resetImageKitFolder(folderPath: string) {
  await deleteImageKitFolder(folderPath);
  await createImageKitFolder(folderPath);
}

async function getUserImageUrls(userId: string): Promise<Array<string | null | undefined>> {
  const result = await pool.query(
    "SELECT profile_picture_url FROM users WHERE id=$1",
    [userId],
  );
  const documents = await pool.query(
    "SELECT image_url FROM user_documents WHERE user_id=$1",
    [userId],
  );
  return [
    result.rows[0]?.profile_picture_url,
    ...documents.rows.map((row) => row.image_url),
  ];
}

async function createGuardAccount(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  body: {
    name: string;
    phoneNumber: string;
    email?: string;
    age: number;
    password: string;
    companyId: string;
    site?: string;
    basicSalary?: number;
  },
) {
  const userId = `user-${randomBytes(8).toString("hex")}`;
  const employeeId = `employee-${randomBytes(8).toString("hex")}`;
  const basicSalary = body.basicSalary ?? 0;
  const mobileNumber = normalizeMobileNumber(body.phoneNumber);
  const email = normalizeEmail(body.email);
  await client.query(
    `INSERT INTO users
     (id, name, email, mobile_number, age, company_id, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SECURITY_GUARD')`,
    [userId, body.name, email, mobileNumber, body.age, body.companyId, hashPassword(body.password)],
  );
  await client.query(
    `INSERT INTO company_assignments (user_id, company_id) VALUES ($1,$2)`,
    [userId, body.companyId],
  );
  await client.query(
    `INSERT INTO employees
     (id, company_id, employee_id, name, contact, email, salary, site, role,
      basic_salary, allowances, overtime, pf, esic, date_of_joining)
      VALUES ($1,$2,nextval('employees_employee_id_seq'),$3,$4,$5,$6,$7,'Security Guard',$8,0,0,0,0,CURRENT_DATE)`,
    [employeeId, body.companyId, body.name, mobileNumber, email, basicSalary, body.site || "Unassigned", basicSalary],
  );
  return {
    user: { id: userId, name: body.name, role: "SECURITY_GUARD" as const },
    employee: { id: employeeId, name: body.name, role: "Security Guard" as const },
  };
}

async function createSupervisorAccount(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  body: {
    name: string;
    phoneNumber: string;
    email?: string;
    password: string;
    companyId: string;
  },
) {
  const userId = `user-${randomBytes(8).toString("hex")}`;
  const employeeId = `employee-${randomBytes(8).toString("hex")}`;
  const mobileNumber = normalizeMobileNumber(body.phoneNumber);
  const email = normalizeEmail(body.email);
  await client.query(
    `INSERT INTO users
     (id, name, email, mobile_number, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,'SUPERVISOR')`,
    [
      userId,
      body.name,
      email,
      mobileNumber,
      hashPassword(body.password),
    ],
  );
  await client.query(
    `INSERT INTO employees
     (id, company_id, employee_id, name, contact, email, salary, site, role,
      basic_salary, allowances, overtime, pf, esic, date_of_joining)
     VALUES ($1,$2,nextval('employees_employee_id_seq'),$3,$4,$5,0,'Unassigned','Supervisor',0,0,0,0,0,CURRENT_DATE)`,
    [employeeId, body.companyId, body.name, mobileNumber, email],
  );
  return {
    user: { id: userId, name: body.name, role: "SUPERVISOR" as const },
    employee: { id: employeeId, name: body.name, role: "Supervisor" as const },
  };
}

function parseBody<T>(schema: z.ZodType<T>, req: ApiRequest, res: ApiResponse) {
  let raw = req.body;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    sendError(res, 400, "INVALID_REQUEST", "Request data is invalid.");
    return null;
  }
  return result.data;
}

function parseMonthYear(req: ApiRequest, res: ApiResponse) {
  const result = monthYearSchema.safeParse(req.query);
  if (!result.success) {
    sendError(res, 400, "INVALID_DATE_RANGE", "Year and month must be valid.");
    return null;
  }
  return result.data;
}

async function ensureSeed() {
  await ensureSchema();
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id TEXT`);
  await pool.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_url TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_documents (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, document_type TEXT NOT NULL,
    image_url TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const companies = [
    ["company-isf", "INDUSTRIAL SECURITY FORCE"],
    ["company-tis", "TARGET INDUSTRIAL SECURITY"],
    ["company-tssm", "TARGET SECURITY SERVICE & MANPOWER"],
    ["company-tisf", "TARGET INDUSTRIAL SECURITY FORCE Pvt Ltd"],
    ["company-ke", "KARNIKA ENTERPRISES"],
  ];

  for (const [id, name] of companies) {
    await pool.query(
      `INSERT INTO companies (id, name, gst, account_no, office_number)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [id, name, "GSTIN pending", "Account pending", "+91 00000 00000"],
    );
  }

  const accountRows = [
    ["company-isf", 999999, 0, 0, 0, 0, 0],
    ["company-tis", 772099, 617999, 57000, 0, 0, 0],
    ["company-tssm", 733319, 0, 0, 0, 0, 0],
    ["company-tisf", 101000, 19000, 0, 0, 0, 0],
    ["company-ke", 495600, 0, 0, 0, 0, 0],
  ] as const;
  for (const [companyId, billing, receiving, cash, salary, expense, dressStock] of accountRows) {
    await pool.query(
      `INSERT INTO account_sheets
       (id, company_id, month, year, total_billing, total_receiving, cash_received, salary, expense, dress_stock)
       VALUES ($1,$2,6,2026,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [`account-2026-06-${companyId}`, companyId, billing, receiving, cash, salary, expense, dressStock],
    );
  }
}

async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
      mobile_number TEXT, profile_picture_url TEXT, age INTEGER, company_id TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_url TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_number_idx ON users (mobile_number) WHERE mobile_number IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, logo_url TEXT, gst TEXT NOT NULL DEFAULT '—',
      account_no TEXT NOT NULL DEFAULT '—', office_number TEXT NOT NULL DEFAULT '—',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS company_assignments (
      user_id TEXT NOT NULL, company_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, employee_id BIGINT NOT NULL,
       name TEXT NOT NULL, contact TEXT NOT NULL, email TEXT,
      salary NUMERIC NOT NULL DEFAULT 0, site TEXT NOT NULL, role TEXT NOT NULL,
      basic_salary NUMERIC NOT NULL DEFAULT 0, allowances NUMERIC NOT NULL DEFAULT 0,
      overtime NUMERIC NOT NULL DEFAULT 0, pf NUMERIC NOT NULL DEFAULT 0,
      esic NUMERIC NOT NULL DEFAULT 0, profile_picture_url TEXT,
      date_of_joining DATE NOT NULL, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_id BIGINT`,
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS employees_contact_idx ON employees (contact) WHERE deleted_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS employees_email_lower_idx ON employees (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL`,
    `WITH numbered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS employee_id
       FROM employees WHERE employee_id IS NULL
     )
     UPDATE employees e SET employee_id = numbered.employee_id
     FROM numbered WHERE e.id = numbered.id`,
    `ALTER TABLE employees ALTER COLUMN employee_id SET NOT NULL`,
    `CREATE SEQUENCE IF NOT EXISTS employees_employee_id_seq AS BIGINT`,
    `SELECT setval('employees_employee_id_seq', COALESCE((SELECT MAX(employee_id) FROM employees), 1), EXISTS (SELECT 1 FROM employees))`,
    `ALTER TABLE employees ALTER COLUMN employee_id SET DEFAULT nextval('employees_employee_id_seq')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS employees_employee_id_idx ON employees (employee_id)`,
    `DROP INDEX IF EXISTS employees_number_idx`,
    `DROP INDEX IF EXISTS employees_id_card_idx`,
    `ALTER TABLE employees DROP COLUMN IF EXISTS employee_number`,
    `ALTER TABLE employees DROP COLUMN IF EXISTS id_card`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, date DATE NOT NULL, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS salary_records (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, month INTEGER NOT NULL, year INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS salary_transactions (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, type TEXT NOT NULL, amount NUMERIC NOT NULL,
      note TEXT NOT NULL, month INTEGER NOT NULL, year INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS account_sheets (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, month INTEGER NOT NULL, year INTEGER NOT NULL,
      total_billing NUMERIC NOT NULL DEFAULT 0, total_receiving NUMERIC NOT NULL DEFAULT 0,
      cash_received NUMERIC NOT NULL DEFAULT 0, salary NUMERIC NOT NULL DEFAULT 0,
       expense NUMERIC NOT NULL DEFAULT 0, dress_stock NUMERIC NOT NULL DEFAULT 0,
       balance NUMERIC NOT NULL DEFAULT 0, profit NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE account_sheets ADD COLUMN IF NOT EXISTS balance NUMERIC NOT NULL DEFAULT 0`,
    `ALTER TABLE account_sheets ADD COLUMN IF NOT EXISTS profit NUMERIC NOT NULL DEFAULT 0`,
    `CREATE UNIQUE INDEX IF NOT EXISTS account_sheets_company_month_idx ON account_sheets (company_id, year, month)`,
  ];
  for (const statement of statements) await pool.query(statement);
}


async function authenticate(req: ApiRequest, res: ApiResponse) {
  try {
    const rawAuthorization = req.headers.authorization;
    const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!token) {
      sendError(res, 401, "UNAUTHORIZED", "Sign in to continue.");
      return false;
    }
    const result = await pool.query<UserRecord & {
      mobile_number: string | null;
      profile_picture_url: string | null;
      expires_at: Date;
    }>(
      `SELECT u.id, u.name, u.email, u.mobile_number, u.profile_picture_url, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token],
    );
    const user = result.rows[0];
    if (!user || new Date(user.expires_at).getTime() <= Date.now()) {
      sendError(res, 401, "UNAUTHORIZED", "Your session has expired.");
      return false;
    }
    req.auth = {
      id: user.id,
      name: user.name,
      email: user.email,
      mobileNumber: user.mobile_number,
      profilePictureUrl: user.profile_picture_url,
      role: user.role,
    };
    req.token = token;
    return true;
  } catch (error) {
    logger.error({ err: error }, "Authentication failed");
    sendError(res, 500, "AUTH_ERROR", "Unable to verify the session.");
    return false;
  }
}

function requireRole(req: ApiRequest, res: ApiResponse, ...roles: Role[]) {
  if (!req.auth || !roles.includes(req.auth.role)) {
    sendError(res, 403, "FORBIDDEN", "You do not have permission for this action.");
    return false;
  }
  return true;
}

function requireManagementRole(req: ApiRequest, res: ApiResponse) {
  return requireRole(req, res, "ADMIN", "SUPERVISOR");
}

async function canAccessCompany(user: UserRecord, companyId: string) {
  if (user.role === "ADMIN" || user.role === "SUPERVISOR") return true;
  return false;
}

async function employeeForRequest(req: ApiRequest, res: ApiResponse) {
  const user = req.auth!;
  const employeeId = Number(req.params.employeeId);
  if (!Number.isSafeInteger(employeeId) || employeeId < 1) {
    sendError(res, 400, "INVALID_EMPLOYEE_ID", "Employee ID must be a positive number.");
    return null;
  }
  const result = await pool.query("SELECT * FROM employees WHERE employee_id = $1 AND deleted_at IS NULL", [employeeId]);
  const employee = result.rows[0];
  if (!employee) {
    sendError(res, 404, "NOT_FOUND", "Employee not found.");
    return null;
  }
  if (!(await canAccessCompany(user, employee.company_id))) {
    sendError(res, 403, "FORBIDDEN", "This employee is outside your assigned companies.");
    return null;
  }
  return employee;
}

async function guardEmployee(req: ApiRequest, res: ApiResponse) {
  if (req.auth!.role !== "SECURITY_GUARD") {
    sendError(res, 403, "FORBIDDEN", "This endpoint is only available to security guards.");
    return null;
  }
  const result = await pool.query(
    `SELECT e.* FROM employees e
     JOIN company_assignments ca ON ca.company_id = e.company_id
     WHERE ca.user_id = $1 AND e.name = $2 AND e.role = 'Security Guard'
       AND e.deleted_at IS NULL
     ORDER BY e.id LIMIT 1`,
    [req.auth!.id, req.auth!.name],
  );
  const employee = result.rows[0];
  if (!employee) {
    sendError(res, 404, "NOT_FOUND", "Your guard profile is not assigned.");
    return null;
  }
  return employee;
}

function employeePayload(row: Record<string, unknown>) {
  return {
    id: row.id,
    companyId: row.company_id,
    employeeId: Number(row.employee_id),
    name: row.name,
    contact: row.contact,
    email: row.email,
    salary: money(row.salary),
    site: row.site,
    role: row.role,
    basicSalary: money(row.basic_salary),
    allowances: money(row.allowances),
    overtime: money(row.overtime),
    pf: money(row.pf),
    esic: money(row.esic),
    profilePictureUrl: cacheBustedImageUrl(row.profile_picture_url as string | null | undefined, row.updated_at),
    dateOfJoining: row.date_of_joining,
  };
}

function financialPayload(row: Record<string, unknown>) {
  const totalBilling = money(row.total_billing);
  const totalReceiving = money(row.total_receiving);
  const cashReceived = money(row.cash_received);
  const salary = money(row.salary);
  const expense = money(row.expense);
  const dressStock = money(row.dress_stock);
  const balance = totalReceiving + cashReceived - salary - expense;
  return { totalBilling, totalReceiving, cashReceived, salary, balance, expense, dressStock, profit: balance - dressStock };
}

async function companyPayload(
  companyId: string,
  year = 2026,
  month = 6,
  includeFinancials = true,
) {
  const result = await pool.query(
    `SELECT c.*, COALESCE(employee_counts.employee_count, 0)::int AS employee_count,
      COALESCE(a.total_billing,0) AS total_billing,
      COALESCE(a.total_receiving,0) AS total_receiving,
      COALESCE(a.cash_received,0) AS cash_received,
      COALESCE(a.salary,0) AS salary,
      COALESCE(a.expense,0) AS expense,
      COALESCE(a.dress_stock,0) AS dress_stock
     FROM companies c
      LEFT JOIN (
        SELECT company_id, COUNT(*) AS employee_count
        FROM employees
        WHERE deleted_at IS NULL
        GROUP BY company_id
      ) employee_counts ON employee_counts.company_id = c.id
      LEFT JOIN account_sheets a ON a.company_id = c.id AND a.month = $2 AND a.year = $3
     WHERE c.id = $1
      `,
    [companyId, month, year],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    logoUrl: cacheBustedImageUrl(row.logo_url, row.updated_at),
    gst: row.gst,
    accountNo: row.account_no,
    officeNumber: row.office_number,
    employeeCount: Number(row.employee_count),
    ...(includeFinancials ? { financials: financialPayload(row) } : {}),
  };
}

async function salaryPayload(employee: Record<string, unknown>, year: number, month: number) {
  const transactions = await pool.query(
    `SELECT type, COALESCE(SUM(amount),0) AS total
     FROM salary_transactions WHERE employee_id = $1 AND year = $2 AND month = $3 GROUP BY type`,
    [employee.id, year, month],
  );
  const advance = money(transactions.rows.find((row) => row.type === "ADVANCE")?.total);
  const fine = money(transactions.rows.find((row) => row.type === "FINE")?.total);
  const basicSalary = money(employee.basic_salary);
  const allowances = money(employee.allowances);
  const overtime = money(employee.overtime);
  const grossSalary = basicSalary + allowances + overtime;
  const pf = money(employee.pf);
  const esic = money(employee.esic);
  const totalDeduction = advance + fine + pf + esic;
  return { year, month, basicSalary, allowances, overtime, grossSalary, advance, fine, pf, esic, totalDeduction, netSalary: grossSalary - totalDeduction };
}

function route(req: ApiRequest, method: string, pattern: string) {
  if (req.method !== method) return null;
  return pathParams(req.path, pattern);
}

export async function handleManagement(req: ApiRequest, res: ApiResponse): Promise<boolean> {
  let params = route(req, "POST", "/auth/login");
  if (params) {
    req.params = params;
    await ensureSeed();
    const body = parseBody(loginSchema, req, res);
    if (!body) return true;
    const result = await pool.query(
      `SELECT id, name, email, mobile_number, profile_picture_url, role, password_hash
       FROM users WHERE lower(COALESCE(email, '')) = lower($1) OR mobile_number = $1
       LIMIT 1`,
      [body.identifier],
    );
    const row = result.rows[0];
    if (!row) {
      sendError(res, 401, "ACCOUNT_NOT_FOUND", "No account exists with this phone number or email.");
      return true;
    }
    if (!verifyPassword(body.password, row.password_hash)) {
      sendError(res, 401, "INVALID_PASSWORD", "Password is incorrect.");
      return true;
    }
    const token = randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [token, row.id],
    );
    res.json({
      token,
      user: {
        id: row.id,
        name: row.name,
        email: row.email,
        mobileNumber: row.mobile_number,
        profilePictureUrl: row.profile_picture_url,
        role: row.role,
      },
    });
    return true;
  }

  params = route(req, "POST", "/auth/register-guard");
  if (params) {
    req.params = params;
    await ensureSeed();
    const body = parseBody(guardRegistrationSchema, req, res);
    if (!body) return true;
    const company = COMPANY_CATALOG[body.companyCode as keyof typeof COMPANY_CATALOG];
    if (!company) {
      sendError(res, 400, "INVALID_COMPANY_CODE", "Company Code is invalid.");
      return true;
    }

     const duplicate = await findDuplicateContact(pool, { mobileNumber: body.phoneNumber, email: body.email });
     if (duplicate) {
       sendDuplicateContactError(res, duplicate);
      return true;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = await createGuardAccount(client, { ...body, companyId: company.id });
      await client.query("COMMIT");
      res.status(201).json({
        message: "Security Guard account created.",
        companyId: company.id,
        ...created,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const duplicate = duplicateFromDatabaseError(error);
      if (duplicate) {
        sendDuplicateContactError(res, duplicate);
        return true;
      }
      logger.error({ err: error }, "Guard registration failed");
      sendError(res, 500, "REGISTRATION_FAILED", "Unable to create the account.");
    } finally {
      client.release();
    }
    return true;
  }

  params = route(req, "POST", "/companies/:companyId/guard-accounts");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN", "SUPERVISOR")) return true;
    if (!(await canAccessCompany(req.auth!, req.params.companyId))) {
      sendError(res, 403, "FORBIDDEN", "This company is outside your assigned companies.");
      return true;
    }
    const body = parseBody(guardEmployeeRegistrationSchema, req, res);
    if (!body) return true;
     const duplicate = await findDuplicateContact(pool, { mobileNumber: body.phoneNumber, email: body.email });
     if (duplicate) {
       sendDuplicateContactError(res, duplicate);
      return true;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = await createGuardAccount(client, {
        ...body,
        companyId: req.params.companyId,
      });
      await client.query("COMMIT");
      res.status(201).json({
        message: "Security Guard account created.",
        companyId: req.params.companyId,
        ...created,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const duplicate = duplicateFromDatabaseError(error);
      if (duplicate) {
        sendDuplicateContactError(res, duplicate);
        return true;
      }
      logger.error({ err: error }, "Guard employee account creation failed");
      sendError(res, 500, "REGISTRATION_FAILED", "Unable to create the account.");
    } finally {
      client.release();
    }
    return true;
  }

  params = route(req, "POST", "/companies/:companyId/supervisor-accounts");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN")) return true;
    if (!(await canAccessCompany(req.auth!, req.params.companyId))) {
      sendError(res, 403, "FORBIDDEN", "This company is outside your assigned companies.");
      return true;
    }
    const body = parseBody(supervisorEmployeeRegistrationSchema, req, res);
    if (!body) return true;
    const duplicate = await findDuplicateContact(pool, {
      mobileNumber: body.phoneNumber,
      email: body.email,
    });
    if (duplicate) {
      sendDuplicateContactError(res, duplicate);
      return true;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = await createSupervisorAccount(client, {
        ...body,
        companyId: req.params.companyId,
      });
      await client.query("COMMIT");
      res.status(201).json({
        message: "Supervisor account created.",
        companyId: req.params.companyId,
        ...created,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const duplicate = duplicateFromDatabaseError(error);
      if (duplicate) {
        sendDuplicateContactError(res, duplicate);
        return true;
      }
      logger.error({ err: error }, "Supervisor employee account creation failed");
      sendError(res, 500, "REGISTRATION_FAILED", "Unable to create the account.");
    } finally {
      client.release();
    }
    return true;
  }

  params = route(req, "GET", "/settings/imagekit-auth");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res))) return true;
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
    const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;
    if (!privateKey || !publicKey || !urlEndpoint) {
      sendError(res, 503, "IMAGEKIT_NOT_CONFIGURED", "ImageKit is not configured yet.");
      return true;
    }
    const expire = Math.floor(Date.now() / 1000) + 600;
    const token = randomBytes(16).toString("hex");
    const signature = createHmac("sha1", privateKey).update(token + expire).digest("hex");
    let folder = `/users/${req.auth!.id}`;
    const companyId = String(req.query.companyId ?? "").trim();
    if (companyId) {
      if (req.auth!.role !== "ADMIN") {
        sendError(res, 403, "FORBIDDEN", "Only admins can upload company logos.");
        return true;
      }
      const company = await pool.query("SELECT id FROM companies WHERE id=$1", [companyId]);
      if (!company.rows[0]) {
        sendError(res, 404, "NOT_FOUND", "Company not found.");
        return true;
      }
      folder = imageKitFolderForCompany(companyId);
      try {
        // Company logos use a fixed filename. Resetting the folder before the
        // signed upload avoids fragile URL/file lookups for the previous logo.
        await resetImageKitFolder(folder);
      } catch (error) {
        logger.error({ err: error, companyId, folder }, "Company logo folder reset failed");
        sendError(res, 502, "IMAGE_CLEANUP_FAILED", "The company logo folder could not be reset.");
        return true;
      }
    }
    if (req.auth!.role === "SECURITY_GUARD") {
      const employee = await pool.query(
        `SELECT e.employee_id
         FROM employees e
         JOIN company_assignments ca ON ca.company_id = e.company_id
         JOIN users u ON u.id = ca.user_id
         WHERE ca.user_id = $1
           AND e.deleted_at IS NULL
           AND (e.name = u.name OR e.contact = u.mobile_number)
         ORDER BY e.created_at
         LIMIT 1`,
        [req.auth!.id],
      );
      if (!employee.rows[0]) {
        sendError(res, 409, "EMPLOYEE_NOT_FOUND", "Your employee profile is not available.");
        return true;
      }
      folder = imageKitFolderForEmployee(employee.rows[0].employee_id);
    } else if (req.auth!.role === "SUPERVISOR") {
      const employee = await pool.query(
        `SELECT e.employee_id
         FROM employees e
         WHERE e.role = 'Supervisor'
           AND e.deleted_at IS NULL
           AND (e.name = $1 OR e.contact = $2)
         ORDER BY e.created_at
         LIMIT 1`,
        [req.auth!.name, req.auth!.mobileNumber],
      );
      if (!employee.rows[0]) {
        sendError(res, 409, "EMPLOYEE_NOT_FOUND", "Your employee profile is not available.");
        return true;
      }
      folder = imageKitFolderForEmployee(employee.rows[0].employee_id);
    }
    res.json({ token, expire, signature, publicKey, urlEndpoint, folder });
    return true;
  }

  params = route(req, "PATCH", "/settings/profile");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res))) return true;
    const body = parseBody(profileUpdateSchema, req, res);
    if (!body) return true;
     const ownEmployee = req.auth!.role === "SUPERVISOR"
       ? await pool.query(
         `SELECT e.id FROM employees e
          WHERE e.role='Supervisor' AND e.deleted_at IS NULL
            AND (e.name=$1 OR e.contact=$2) LIMIT 1`,
         [req.auth!.name, req.auth!.mobileNumber],
       )
       : await pool.query(
         `SELECT e.id FROM employees e
          JOIN company_assignments ca ON ca.company_id = e.company_id
          WHERE ca.user_id=$1 AND e.role='Security Guard' AND e.deleted_at IS NULL
            AND (e.name=$2 OR e.contact=$3) LIMIT 1`,
         [req.auth!.id, req.auth!.name, req.auth!.mobileNumber],
       );
     const duplicate = await findDuplicateContact(pool, {
       mobileNumber: body.mobileNumber,
       email: body.email,
       excludeUserId: req.auth!.id,
       excludeEmployeeId: ownEmployee.rows[0]?.id,
     });
     if (duplicate) {
       sendDuplicateContactError(res, duplicate);
      return true;
    }
    const previous = await pool.query(
      "SELECT profile_picture_url FROM users WHERE id=$1",
      [req.auth!.id],
    );
    const previousUrl = previous.rows[0]?.profile_picture_url as string | null | undefined;
    const nextUrl = body.profilePictureUrl || null;
    if (previousUrl && previousUrl !== nextUrl) {
      try {
        await deleteImageKitFile(previousUrl);
      } catch (error) {
        logger.error({ err: error, userId: req.auth!.id }, "Previous profile image cleanup failed");
        if (nextUrl && nextUrl !== previousUrl) {
          try {
            await deleteImageKitFile(nextUrl);
          } catch (cleanupError) {
            logger.error({ err: cleanupError, userId: req.auth!.id }, "New profile image rollback failed");
          }
        }
        sendError(res, 502, "IMAGE_CLEANUP_FAILED", "The previous profile picture could not be removed.");
        return true;
      }
    }
    let result;
    try {
      result = await pool.query(
        `UPDATE users SET name=$1, email=$2, mobile_number=$3, profile_picture_url=$4, updated_at=NOW()
         WHERE id=$5
         RETURNING id, name, email, mobile_number, profile_picture_url, role`,
        [
          body.name,
          normalizeEmail(body.email),
          normalizeMobileNumber(body.mobileNumber) || null,
          body.profilePictureUrl || null,
          req.auth!.id,
        ],
      );
    } catch (error) {
      const duplicate = duplicateFromDatabaseError(error);
      if (duplicate) {
        sendDuplicateContactError(res, duplicate);
        return true;
      }
      throw error;
    }
     if (ownEmployee.rows[0]) {
      await pool.query(
        `UPDATE employees e
         SET name=$1, profile_picture_url=$2, updated_at=NOW()
          WHERE e.id=$3 AND e.deleted_at IS NULL`,
        [
          body.name,
          body.profilePictureUrl || null,
           ownEmployee.rows[0].id,
        ],
      );
    }
    const row = result.rows[0];
    res.json({
      id: row.id, name: row.name, email: row.email, mobileNumber: row.mobile_number,
      profilePictureUrl: row.profile_picture_url, role: row.role,
    });
    return true;
  }

  params = route(req, "PATCH", "/settings/password");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res))) return true;
    const body = parseBody(passwordUpdateSchema, req, res);
    if (!body) return true;
    const result = await pool.query("SELECT password_hash FROM users WHERE id=$1", [req.auth!.id]);
    if (!result.rows[0] || !verifyPassword(body.currentPassword, result.rows[0].password_hash)) {
      sendError(res, 400, "INVALID_PASSWORD", "Current password is incorrect.");
      return true;
    }
    await pool.query("UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2", [
      hashPassword(body.newPassword), req.auth!.id,
    ]);
    res.status(204).send();
    return true;
  }

  params = route(req, "GET", "/settings/documents");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "SUPERVISOR", "SECURITY_GUARD")) return true;
    const result = await pool.query(
      "SELECT id, document_type, image_url, created_at, updated_at FROM user_documents WHERE user_id=$1 ORDER BY created_at DESC",
      [req.auth!.id],
    );
    res.json(result.rows.map((row) => ({
      id: row.id, documentType: row.document_type,
      imageUrl: cacheBustedImageUrl(row.image_url, row.updated_at),
      createdAt: row.created_at,
    })));
    return true;
  }

  params = route(req, "PUT", "/settings/documents/aadhaar");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "SUPERVISOR", "SECURITY_GUARD")) return true;
    const body = parseBody(documentSchema, req, res);
    if (!body) return true;
    const previous = await pool.query(
      "SELECT image_url FROM user_documents WHERE id=$1",
      [`aadhaar-${req.auth!.id}`],
    );
    const previousUrl = previous.rows[0]?.image_url as string | null | undefined;
    if (previousUrl && previousUrl !== body.imageUrl) {
      try {
        await deleteImageKitFile(previousUrl);
      } catch (error) {
        logger.error({ err: error, userId: req.auth!.id }, "Previous document image cleanup failed");
        try {
          await deleteImageKitFile(body.imageUrl);
        } catch (cleanupError) {
          logger.error({ err: cleanupError, userId: req.auth!.id }, "New document image rollback failed");
        }
        sendError(res, 502, "IMAGE_CLEANUP_FAILED", "The previous document image could not be removed.");
        return true;
      }
    }
    const result = await pool.query(
      `INSERT INTO user_documents (id, user_id, document_type, image_url)
       VALUES ($1, $2, 'AADHAAR', $3)
       ON CONFLICT (id) DO UPDATE SET image_url=EXCLUDED.image_url, updated_at=NOW()
       RETURNING id, document_type, image_url, created_at, updated_at`,
      [`aadhaar-${req.auth!.id}`, req.auth!.id, body.imageUrl],
    );
    const row = result.rows[0];
    res.json({
      id: row.id,
      documentType: row.document_type,
      imageUrl: cacheBustedImageUrl(row.image_url, row.updated_at),
      createdAt: row.created_at,
    });
    return true;
  }

  params = route(req, "GET", "/guard/me");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res))) return true;
    const employee = await guardEmployee(req, res);
    if (employee) res.json(employeePayload(employee));
    return true;
  }

  params = route(req, "GET", "/guard/attendance");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res))) return true;
    const employee = await guardEmployee(req, res);
    if (!employee) return true;
    const values = parseMonthYear(req, res);
    if (!values) return true;
    const result = await pool.query(
      `SELECT date::text, status FROM attendance
       WHERE employee_id=$1 AND EXTRACT(YEAR FROM date)=$2 AND EXTRACT(MONTH FROM date)=$3
       ORDER BY date`,
      [employee.id, values.year, values.month],
    );
    const records = result.rows;
    const presentDays = records.filter((row) => row.status === "PRESENT").length;
    const absentDays = records.filter((row) => row.status === "ABSENT").length;
    res.json({ year: values.year, month: values.month, presentDays, absentDays, net: presentDays - absentDays, records });
    return true;
  }

  params = route(req, "GET", "/guard/salary");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res))) return true;
    const employee = await guardEmployee(req, res);
    if (!employee) return true;
    const values = parseMonthYear(req, res);
    if (!values) return true;
    res.json(await salaryPayload(employee, values.year, values.month));
    return true;
  }

  params = route(req, "GET", "/auth/me");
  if (params) {
    req.params = params;
    if (await authenticate(req, res)) res.json(req.auth);
    return true;
  }

  params = route(req, "POST", "/auth/logout");
  if (params) {
    req.params = params;
    if (await authenticate(req, res)) res.status(204).send();
    if (req.token) await pool.query("DELETE FROM sessions WHERE token = $1", [req.token]);
    return true;
  }

  params = route(req, "GET", "/companies");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    await ensureSeed();
    const user = req.auth!;
    const result = await pool.query("SELECT id FROM companies ORDER BY name");
    const companies = [];
    for (const row of result.rows) {
      const company = await companyPayload(row.id, 2026, 6, user.role === "ADMIN");
      if (company) companies.push(company);
    }
    res.json(companies);
    return true;
  }

  params = route(req, "POST", "/companies");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN")) return true;
    const body = parseBody(companySchema, req, res);
    if (!body) return true;
    const id = `company-${createHash("sha1").update(`${Date.now()}-${body.name}`).digest("hex").slice(0, 10)}`;
    await pool.query(
      `INSERT INTO companies (id, name, logo_url, gst, account_no, office_number)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, body.name, body.logoUrl ?? null, body.gst ?? "—", body.accountNo ?? "—", body.officeNumber ?? "—"],
    );
    res.status(201).json(await companyPayload(id));
    return true;
  }

  params = route(req, "GET", "/companies/:companyId");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const user = req.auth!;
    if (!(await canAccessCompany(user, req.params.companyId))) {
      sendError(res, 403, "FORBIDDEN", "This company is outside your assigned companies.");
      return true;
    }
    const values = parseMonthYear(req, res);
    if (!values) return true;
    const company = await companyPayload(
      req.params.companyId,
      values.year,
      values.month,
      user.role === "ADMIN",
    );
    if (!company) {
      sendError(res, 404, "NOT_FOUND", "Company not found.");
      return true;
    }
    res.json(company);
    return true;
  }

  params = route(req, "PATCH", "/companies/:companyId");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN")) return true;
    const body = parseBody(companySchema, req, res);
    if (!body) return true;
    const previous = await pool.query("SELECT logo_url FROM companies WHERE id=$1", [req.params.companyId]);
    if (!previous.rows[0]) {
      sendError(res, 404, "NOT_FOUND", "Company not found.");
      return true;
    }
    await pool.query(
      `UPDATE companies SET name=$1, logo_url=$2, gst=$3, account_no=$4, office_number=$5, updated_at=NOW() WHERE id=$6`,
      [body.name, body.logoUrl ?? null, body.gst ?? "—", body.accountNo ?? "—", body.officeNumber ?? "—", req.params.companyId],
    );
    const company = await companyPayload(req.params.companyId);
    if (!company) {
      sendError(res, 404, "NOT_FOUND", "Company not found.");
      return true;
    }
    res.json(company);
    return true;
  }

  params = route(req, "GET", "/companies/:companyId/employees");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const user = req.auth!;
    if (!(await canAccessCompany(user, req.params.companyId))) {
      sendError(res, 403, "FORBIDDEN", "This company is outside your assigned companies.");
      return true;
    }
    const search = String(req.query.search ?? "").trim();
    const result = await pool.query(
      `SELECT * FROM employees
       WHERE company_id = $1 AND deleted_at IS NULL
       AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR employee_id::text ILIKE '%' || $2 || '%' OR site ILIKE '%' || $2 || '%')
       ORDER BY name LIMIT 100`,
      [req.params.companyId, search],
    );
    res.json(result.rows.map(employeePayload));
    return true;
  }

  params = route(req, "POST", "/companies/:companyId/employees");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN", "SUPERVISOR")) return true;
    if (!(await canAccessCompany(req.auth!, req.params.companyId))) {
      sendError(res, 403, "FORBIDDEN", "This company is outside your assigned companies.");
      return true;
    }
    const body = parseBody(employeeSchema, req, res);
    if (!body) return true;
    const role = req.auth!.role === "SUPERVISOR" ? "Security Guard" : body.role;
    const duplicate = await findDuplicateContact(pool, {
      mobileNumber: body.contact,
      email: body.email,
    });
    if (duplicate) {
      sendDuplicateContactError(res, duplicate);
      return true;
    }
    const id = `employee-${randomBytes(8).toString("hex")}`;
    try {
      await pool.query(
        `INSERT INTO employees
         (id, company_id, employee_id, name, contact, email, salary, site, role, basic_salary, allowances, overtime, pf, esic, profile_picture_url, date_of_joining)
         VALUES ($1,$2,nextval('employees_employee_id_seq'),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          req.params.companyId,
          body.name,
          normalizeMobileNumber(body.contact),
          normalizeEmail(body.email),
          body.salary,
          body.site,
          role,
          body.basicSalary,
          body.allowances,
          body.overtime,
          body.pf,
          body.esic,
          body.profilePictureUrl ?? null,
          body.dateOfJoining,
        ],
      );
    } catch (error) {
      const duplicate = duplicateFromDatabaseError(error);
      if (duplicate) {
        sendDuplicateContactError(res, duplicate);
        return true;
      }
      logger.error({ err: error }, "Employee creation failed");
      sendError(res, 500, "CREATE_FAILED", "Unable to create the employee.");
      return true;
    }
    const employee = await pool.query("SELECT * FROM employees WHERE id = $1", [id]);
    res.status(201).json(employeePayload(employee.rows[0]));
    return true;
  }

  params = route(req, "GET", "/employees/:employeeId");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const employee = await employeeForRequest(req, res);
    if (employee) res.json(employeePayload(employee));
    return true;
  }

  params = route(req, "GET", "/employees/:employeeId/documents/aadhaar");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    const account = await pool.query(
      `SELECT u.id
       FROM users u
       WHERE u.role = CASE WHEN $4 = 'Supervisor' THEN 'SUPERVISOR' ELSE 'SECURITY_GUARD' END
         AND (u.name=$2 OR u.mobile_number=$3)
         AND (
           u.role = 'SUPERVISOR'
           OR EXISTS (
             SELECT 1 FROM company_assignments ca
             WHERE ca.user_id = u.id AND ca.company_id = $1
           )
         )
       LIMIT 1`,
      [employee.company_id, employee.name, employee.contact, employee.role],
    );
    if (!account.rows[0]) {
      res.json(null);
      return true;
    }
    const document = await pool.query(
      `SELECT image_url, updated_at
       FROM user_documents
       WHERE user_id=$1 AND document_type='AADHAAR'
       ORDER BY created_at DESC LIMIT 1`,
      [account.rows[0].id],
    );
    const row = document.rows[0];
    res.json(row ? { imageUrl: cacheBustedImageUrl(row.image_url, row.updated_at) } : null);
    return true;
  }

  params = route(req, "PATCH", "/employees/:employeeId");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const body = parseBody(employeeSchema, req, res);
    if (!body) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    if (req.auth!.role === "SUPERVISOR" && employee.role === "Supervisor") {
      sendError(res, 403, "FORBIDDEN", "Supervisors cannot edit another supervisor.");
      return true;
    }
    const role = req.auth!.role === "SUPERVISOR" ? "Security Guard" : body.role;
    const linkedUser = await pool.query(
     `SELECT u.id FROM users u
        JOIN company_assignments ca ON ca.user_id = u.id
        WHERE ca.company_id=$1
          AND u.role = CASE WHEN $4 = 'Supervisor' THEN 'SUPERVISOR' ELSE 'SECURITY_GUARD' END
          AND (u.name=$2 OR u.mobile_number=$3) LIMIT 1`,
      [employee.company_id, employee.name, employee.contact, employee.role],
    );
    const duplicate = await findDuplicateContact(pool, {
      mobileNumber: body.contact,
      email: body.email,
      excludeEmployeeId: employee.id,
      excludeUserId: linkedUser.rows[0]?.id,
    });
    if (duplicate) {
      sendDuplicateContactError(res, duplicate);
      return true;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
         `UPDATE employees SET name=$1, contact=$2, email=$3, salary=$4, site=$5, role=$6, basic_salary=$7,
          allowances=$8, overtime=$9, pf=$10, esic=$11, profile_picture_url=$12, date_of_joining=$13, updated_at=NOW()
          WHERE id=$14 AND company_id=$15 AND deleted_at IS NULL`,
         [
           body.name,
           normalizeMobileNumber(body.contact),
           normalizeEmail(body.email),
           body.salary,
           body.site,
           role,
           body.basicSalary,
           body.allowances,
           body.overtime,
           body.pf,
           body.esic,
           body.profilePictureUrl ?? null,
           body.dateOfJoining,
           employee.id,
           employee.company_id,
         ],
      );
       // Keep a linked account's login identity aligned with the employee record.
      await client.query(
         `UPDATE users SET name=$1, email=$2, mobile_number=$3, updated_at=NOW()
          WHERE id=$4`,
         [
           body.name,
           normalizeEmail(body.email),
           normalizeMobileNumber(body.contact),
           linkedUser.rows[0]?.id ?? null,
         ],
      );
      const updated = await client.query("SELECT * FROM employees WHERE id = $1", [employee.id]);
      if (!updated.rows[0]) {
        throw new Error("The employee could not be found after the update.");
      }
      await client.query("COMMIT");
      res.json(employeePayload(updated.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK");
      const duplicate = duplicateFromDatabaseError(error);
      if (duplicate) {
        sendDuplicateContactError(res, duplicate);
        return true;
      }
      logger.error({ err: error, employeeId: employee.id }, "Employee update failed");
      sendError(res, 500, "UPDATE_FAILED", "Unable to update the employee.");
    } finally {
      client.release();
    }
    return true;
  }

  params = route(req, "DELETE", "/employees/:employeeId");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    // Ensure employee-related tables exist on databases created before the
    // employee deletion flow was introduced.
    await ensureSeed();
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    if (req.auth!.role === "SUPERVISOR" && employee.role === "Supervisor") {
      sendError(res, 403, "FORBIDDEN", "Supervisors cannot delete another supervisor.");
      return true;
    }
    const account = await pool.query(
      `SELECT u.id
       FROM users u
       WHERE u.role = CASE WHEN $4 = 'Supervisor' THEN 'SUPERVISOR' ELSE 'SECURITY_GUARD' END
         AND (u.name = $2 OR u.mobile_number = $3)
         AND (
           u.role = 'SUPERVISOR'
           OR EXISTS (
             SELECT 1 FROM company_assignments ca
             WHERE ca.user_id = u.id AND ca.company_id = $1
           )
         )
       LIMIT 1`,
      [employee.company_id, employee.name, employee.contact, employee.role],
    );
    const userId = account.rows[0]?.id as string | undefined;

    // Preserve the URLs before deleting their database records.
    let imageUrls: Array<string | null | undefined> = [employee.profile_picture_url];
    if (userId) {
      try {
        imageUrls = [...imageUrls, ...(await getUserImageUrls(userId))];
      } catch (error) {
        logger.error({ err: error, employeeId: employee.id, userId }, "Employee image URL lookup failed");
      }
    }

    const employeeFolder = imageKitFolderForEmployee(employee.employee_id);
    try {
      await deleteImageKitFolder(employeeFolder);
      // URLs from before the employee-folder rollout are not covered by the
      // folder delete, so clean those up individually as well.
      const folderPrefix = `${process.env.IMAGEKIT_URL_ENDPOINT?.replace(/\/+$/, "")}${employeeFolder}/`;
      for (const imageUrl of new Set(imageUrls.filter(
        (url): url is string => typeof url === "string" && !url.startsWith(folderPrefix),
      ))) {
        await deleteImageKitFile(imageUrl);
      }
    } catch (error) {
      logger.error({ err: error, employeeId: employee.id, folder: employeeFolder }, "Employee ImageKit cleanup failed");
      sendError(res, 502, "IMAGE_CLEANUP_FAILED", "Employee files could not be removed.");
      return true;
    }

    const client = await pool.connect();
    let deleted = false;
    try {
      await client.query("BEGIN");
      // Remove all records keyed to this employee before removing the profile.
      await client.query("DELETE FROM attendance WHERE employee_id=$1", [employee.id]);
      await client.query("DELETE FROM salary_records WHERE employee_id=$1", [employee.id]);
      await client.query("DELETE FROM salary_transactions WHERE employee_id=$1", [employee.id]);
      if (userId) {
        await client.query("DELETE FROM user_documents WHERE user_id=$1", [userId]);
        await client.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
        await client.query("DELETE FROM company_assignments WHERE user_id=$1", [userId]);
        await client.query("DELETE FROM users WHERE id=$1", [userId]);
      }
      await client.query("DELETE FROM employees WHERE id=$1", [employee.id]);
      await client.query("COMMIT");
      deleted = true;
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error({ err: error, employeeId: employee.id }, "Employee deletion failed");
      sendError(
        res,
        500,
        "DELETE_FAILED",
        error instanceof Error
          ? `Unable to delete the employee: ${error.message}`
          : "Unable to delete the employee because the database operation failed.",
      );
    } finally {
      client.release();
    }

    if (deleted) {
      res.status(204).send();
    }
    return true;
  }

  params = route(req, "GET", "/employees/:employeeId/attendance");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    const values = parseMonthYear(req, res);
    if (!values) return true;
    const { year, month } = values;
    const result = await pool.query(
      `SELECT date::text, status FROM attendance WHERE employee_id=$1 AND EXTRACT(YEAR FROM date)=$2 AND EXTRACT(MONTH FROM date)=$3 ORDER BY date`,
      [employee.id, year, month],
    );
    const records = result.rows;
    const presentDays = records.filter((row) => row.status === "PRESENT").length;
    const absentDays = records.filter((row) => row.status === "ABSENT").length;
    res.json({ year, month, presentDays, absentDays, net: presentDays - absentDays, records });
    return true;
  }

  params = route(req, "PUT", "/employees/:employeeId/attendance/:date");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const body = parseBody(attendanceSchema, req, res);
    if (!body) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    if (req.auth!.role === "SUPERVISOR" && employee.role === "Supervisor") {
      sendError(res, 403, "FORBIDDEN", "Supervisors cannot mark attendance for another supervisor.");
      return true;
    }
    const dateValue = new Date(`${req.params.date}T00:00:00Z`);
    if (Number.isNaN(dateValue.getTime()) || dateValue > new Date()) {
      sendError(res, 400, "INVALID_DATE", "Future dates cannot be marked as attendance.");
      return true;
    }
    await pool.query(
      `INSERT INTO attendance (id, employee_id, date, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, updated_at=NOW()`,
      [`attendance-${employee.id}-${req.params.date}`, employee.id, req.params.date, body.status],
    );
    const summary = await pool.query(
      `SELECT date::text, status FROM attendance WHERE employee_id=$1 AND EXTRACT(YEAR FROM date)=$2 AND EXTRACT(MONTH FROM date)=$3 ORDER BY date`,
      [employee.id, dateValue.getUTCFullYear(), dateValue.getUTCMonth() + 1],
    );
    const records = summary.rows;
    const presentDays = records.filter((row) => row.status === "PRESENT").length;
    const absentDays = records.filter((row) => row.status === "ABSENT").length;
    res.json({ year: dateValue.getUTCFullYear(), month: dateValue.getUTCMonth() + 1, presentDays, absentDays, net: presentDays - absentDays, records });
    return true;
  }

  params = route(req, "GET", "/employees/:employeeId/salary");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    const values = parseMonthYear(req, res);
    if (!values) return true;
    res.json(await salaryPayload(employee, values.year, values.month));
    return true;
  }

  params = route(req, "POST", "/employees/:employeeId/salary/transaction");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN")) return true;
    const body = parseBody(salaryTransactionSchema, req, res);
    if (!body) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    await pool.query(
      `INSERT INTO salary_transactions (id, employee_id, type, amount, note, month, year) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`salary-${randomBytes(10).toString("hex")}`, employee.id, body.type, body.amount, body.note, body.month, body.year],
    );
    res.status(201).json(await salaryPayload(employee, body.year, body.month));
    return true;
  }

  params = route(req, "PATCH", "/employees/:employeeId/salary");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireManagementRole(req, res)) return true;
    const body = parseBody(salaryUpdateSchema, req, res);
    if (!body) return true;
    const employee = await employeeForRequest(req, res);
    if (!employee) return true;
    if (req.auth!.role !== "ADMIN" && employee.role !== "Security Guard") {
      sendError(res, 403, "FORBIDDEN", "Supervisors can only edit security guard salaries.");
      return true;
    }
    await pool.query(
      `UPDATE employees
       SET salary=$1, basic_salary=$2, allowances=$3, overtime=$4, pf=$5, esic=$6, updated_at=NOW()
       WHERE id=$7`,
      [
        body.basicSalary + body.allowances + body.overtime,
        body.basicSalary,
        body.allowances,
        body.overtime,
        body.pf,
        body.esic,
        employee.id,
      ],
    );
    await pool.query(
      "DELETE FROM salary_transactions WHERE employee_id=$1 AND year=$2 AND month=$3",
      [employee.id, body.year, body.month],
    );
    const transactions = [
      ["ADVANCE", body.advance],
      ["FINE", body.fine],
    ] as const;
    for (const [type, amount] of transactions) {
      if (amount > 0) {
        await pool.query(
          `INSERT INTO salary_transactions (id, employee_id, type, amount, note, month, year)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            `salary-${randomBytes(10).toString("hex")}`,
            employee.id,
            type,
            amount,
            "Updated from salary details",
            body.month,
            body.year,
          ],
        );
      }
    }
    const updatedEmployee = await pool.query("SELECT * FROM employees WHERE id = $1", [
      employee.id,
    ]);
    res.json(await salaryPayload(updatedEmployee.rows[0], body.year, body.month));
    return true;
  }

  params = route(req, "GET", "/account-sheet/:year/:month");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN")) return true;
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    const result = await pool.query(
      `SELECT c.id AS company_id, c.name AS company_name,
       COALESCE(a.total_billing,0) AS total_billing, COALESCE(a.total_receiving,0) AS total_receiving,
       COALESCE(a.cash_received,0) AS cash_received, COALESCE(a.salary,0) AS salary,
       COALESCE(a.balance,0) AS balance, COALESCE(a.expense,0) AS expense,
       COALESCE(a.dress_stock,0) AS dress_stock, COALESCE(a.profit,0) AS profit
       FROM companies c LEFT JOIN account_sheets a ON a.company_id=c.id AND a.year=$1 AND a.month=$2
       ORDER BY c.name`,
      [year, month],
    );
    const rows = result.rows.map((row) => {
      const values = financialPayload(row);
      const balance = values.totalReceiving - values.salary;
      return {
        companyId: row.company_id,
        companyName: row.company_name,
        ...values,
        balance,
        profit: balance - values.expense,
      };
    });
    const totals = rows.reduce((acc, row) => ({
      totalBilling: acc.totalBilling + row.totalBilling,
      totalReceiving: acc.totalReceiving + row.totalReceiving,
      cashReceived: acc.cashReceived + row.cashReceived,
      salary: acc.salary + row.salary,
      balance: acc.balance + row.balance,
      expense: acc.expense + row.expense,
      dressStock: acc.dressStock + row.dressStock,
      profit: acc.profit + row.profit,
    }), { totalBilling: 0, totalReceiving: 0, cashReceived: 0, salary: 0, balance: 0, expense: 0, dressStock: 0, profit: 0 });
    res.json({ year, month, rows, totals });
    return true;
  }

  params = route(req, "PUT", "/account-sheet/:year/:month/:companyId");
  if (params) {
    req.params = params;
    if (!(await authenticate(req, res)) || !requireRole(req, res, "ADMIN")) return true;
    const parsed = accountSheetUpdateSchema.safeParse({
      ...(req.body && typeof req.body === "object" ? req.body : {}),
      companyId: req.params.companyId,
      year: Number(req.params.year),
      month: Number(req.params.month),
    });
    if (!parsed.success) {
      sendError(res, 400, "INVALID_ACCOUNT_SHEET", "Enter valid numeric account sheet values.");
      return true;
    }
    const value = parsed.data;
    const balance = value.totalReceiving - value.salary;
    const profit = balance - value.expense;
    await pool.query(
      `INSERT INTO account_sheets
       (id, company_id, month, year, total_billing, total_receiving, cash_received, salary, balance, expense, dress_stock, profit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (company_id, year, month) DO UPDATE SET
       total_billing=$5,total_receiving=$6,cash_received=$7,salary=$8,balance=$9,
       expense=$10,dress_stock=$11,profit=$12,updated_at=NOW()`,
      [`account-${value.year}-${value.month}-${value.companyId}`, value.companyId, value.month, value.year,
         value.totalBilling, value.totalReceiving, value.cashReceived, value.salary, balance,
         value.expense, value.dressStock, profit],
    );
    res.json({ success: true });
    return true;
  }

  return false;
}
