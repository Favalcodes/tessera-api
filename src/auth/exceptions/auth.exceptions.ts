export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('That email address is already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * A refresh token was presented that had already been spent. Either it was
 * stolen and replayed, or a legitimate client raced itself. Both are handled the
 * same way: the whole token family is revoked.
 */
export class RefreshTokenReuseError extends Error {
  constructor() {
    super('Refresh token reuse detected; all sessions for this login have been revoked');
    this.name = 'RefreshTokenReuseError';
  }
}

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('Refresh token is invalid or expired');
    this.name = 'InvalidRefreshTokenError';
  }
}
