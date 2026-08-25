const {
  AccountRegistrationPolicyError,
  normalizeEmail,
} = require(
  "../../../domain/accounts/accountRegistrationPolicy"
);
const {
  inspectPassword,
} = require(
  "../../../domain/accounts/passwordPolicy"
);

const DUMMY_PASSWORD = "invalid-password-workload";
const DUMMY_PASSWORD_HASH =
  "scrypt$v=1$N=131072,r=8,p=1$" +
  "AAAAAAAAAAAAAAAAAAAAAA$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const AUTHENTICATION_FAILED = Object.freeze({
  authenticated: false,
  code: "AUTHENTICATION_FAILED",
});

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(
      `credential authentication requires ${description}`
    );
  }
}

function internalResult(publicResult, internalValues) {
  const result = { ...publicResult };
  for (const [key, value] of Object.entries(
    internalValues
  )) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function failed(reasonCode, user = null) {
  return internalResult(AUTHENTICATION_FAILED, {
    reasonCode,
    user,
  });
}

function successful({ user, credential, needsRehash }) {
  return internalResult(
    {
      authenticated: true,
      code: "AUTHENTICATION_SUCCEEDED",
    },
    { credential, needsRehash, user }
  );
}

function inspectedInput({
  emailNormalized,
  password,
  valid,
}) {
  const result = { emailNormalized, valid };
  Object.defineProperty(result, "password", {
    configurable: false,
    enumerable: false,
    value: password,
    writable: false,
  });
  return Object.freeze(result);
}

function inspectInput(input, passwordInspector = inspectPassword) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return inspectedInput({
      emailNormalized: null,
      password: DUMMY_PASSWORD,
      valid: false,
    });
  }

  const keys = Object.keys(input).sort();
  const exact = ["email", "password"];
  if (
    keys.length !== exact.length ||
    keys.some((key, index) => key !== exact[index])
  ) {
    return inspectedInput({
      emailNormalized: null,
      password: DUMMY_PASSWORD,
      valid: false,
    });
  }

  let emailNormalized = null;
  try {
    emailNormalized = normalizeEmail(
      input.email
    ).normalized;
  } catch (error) {
    if (
      !(error instanceof AccountRegistrationPolicyError)
    ) {
      throw error;
    }
  }
  const passwordInspection = passwordInspector(
    input.password
  );
  const valid =
    emailNormalized !== null &&
    passwordInspection.ok;

  return inspectedInput({
    emailNormalized,
    password: passwordInspection.ok
      ? input.password
      : DUMMY_PASSWORD,
    valid,
  });
}

function isEligibleCredential(credential) {
  return Boolean(
    credential &&
      credential.status === "active" &&
      credential.algorithm === "scrypt" &&
      credential.algorithm_version === 1 &&
      credential.replaced_at_ms === null &&
      typeof credential.password_hash === "string"
  );
}

function createCredentialAuthenticationService({
  userRepository,
  credentialRepository,
  passwordHasher,
  passwordInspector = inspectPassword,
} = {}) {
  assertMethod(
    userRepository,
    "findByNormalizedEmail",
    "a user repository"
  );
  assertMethod(
    credentialRepository,
    "findActiveByUserId",
    "a credential repository"
  );
  assertMethod(
    passwordHasher,
    "verify",
    "a password hasher"
  );
  if (typeof passwordInspector !== "function") {
    throw new TypeError(
      "credential authentication requires password inspection"
    );
  }

  async function authenticate(input) {
    const inspected = inspectInput(input, passwordInspector);
    const user = inspected.emailNormalized
      ? userRepository.findByNormalizedEmail(
          inspected.emailNormalized
        )
      : null;
    const eligibleUser = Boolean(
      inspected.valid &&
        user &&
        user.status === "active"
    );
    const credential = eligibleUser
      ? credentialRepository.findActiveByUserId(
          user.id
        )
      : null;
    const eligibleCredential =
      isEligibleCredential(credential);
    const encodedPassword = eligibleCredential
      ? credential.password_hash
      : DUMMY_PASSWORD_HASH;

    let verification;
    try {
      verification = await passwordHasher.verify(
        inspected.password,
        encodedPassword
      );
    } catch (error) {
      if (error?.code === "STORED_CREDENTIAL_INVALID") {
        return failed(
          "stored_credential_invalid",
          user
        );
      }
      throw error;
    }

    if (
      !verification ||
      typeof verification.verified !== "boolean" ||
      typeof verification.needsRehash !== "boolean"
    ) {
      throw new TypeError(
        "credential authentication received an invalid verification result"
      );
    }
    if (
      !eligibleUser ||
      !eligibleCredential ||
      !verification.verified
    ) {
      return failed(
        eligibleUser
          ? "credential_rejected"
          : "account_ineligible",
        user
      );
    }

    return successful({
      user,
      credential,
      needsRehash: verification.needsRehash,
    });
  }

  return Object.freeze({ authenticate });
}

module.exports = {
  AUTHENTICATION_FAILED,
  DUMMY_PASSWORD,
  DUMMY_PASSWORD_HASH,
  createCredentialAuthenticationService,
  inspectInput,
  isEligibleCredential,
};
