export interface SessionClaims {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
  sessionId: string;
}

export interface Session {
  accessToken: string;
  claims: SessionClaims;
}

export interface PropertySummary {
  id: string;
  name: string;
  code: string;
  businessDate: string;
  timezone: string;
}

export interface Me {
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; displayName: string };
  role: string;
  permissions: string[];
  allProperties: boolean;
  properties: PropertySummary[];
}

export type LoginResult =
  | Session
  | { status: "MFA_REQUIRED"; mfaToken: string; message: string }
  | {
      status: "MFA_ENROLMENT_REQUIRED";
      setupToken: string;
      role: string;
      message: string;
    };

export interface MfaSetup {
  secret: string;
  otpauthUri: string;
  message: string;
}

export interface ActivatedSession extends Session {
  recoveryCodes: string[];
  message: string;
}
