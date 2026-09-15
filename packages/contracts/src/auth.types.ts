export type UserRole = 'user' | 'admin';

export type UserStatus = 'active' | 'suspended' | 'pending_verification';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  user: AuthUser;
}

export interface RegisterRequest {
  email: string;
  displayName: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}
