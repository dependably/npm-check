// Package-lock.json format definitions and schemas

export const LOCKFILE_VERSIONS = {
  V1: 1,
  V2: 2,
  V3: 3
};

export const LOCKFILE_FORMATS = {
  [LOCKFILE_VERSIONS.V1]: {
    version: 1,
    introduced: 'npm@5.0.0',
    deprecated: 'npm@7.0.0',
    structure: 'flat dependencies object',
    features: {
      topLevel: ['name', 'version', 'lockfileVersion', 'requires', 'dependencies'],
      dependency: ['version', 'resolved', 'integrity', 'dev', 'requires', 'dependencies'],
      supportsWorkspaces: false,
      nestedDependencies: true
    }
  },
  [LOCKFILE_VERSIONS.V2]: {
    version: 2,
    introduced: 'npm@7.0.0',
    current: true,
    structure: 'dual format (v1 + packages)',
    features: {
      topLevel: ['name', 'version', 'lockfileVersion', 'requires', 'packages', 'dependencies'],
      dependency: ['version', 'resolved', 'integrity', 'dev', 'requires', 'dependencies'],
      package: ['version', 'resolved', 'integrity', 'dev', 'devOptional', 'optional', 'peer', 'engines', 'bin', 'dependencies', 'optionalDependencies', 'peerDependencies'],
      supportsWorkspaces: true,
      nestedDependencies: true,
      packagesMap: true
    }
  },
  [LOCKFILE_VERSIONS.V3]: {
    version: 3,
    introduced: 'npm@7.0.0',
    current: true,
    structure: 'packages only',
    features: {
      topLevel: ['name', 'version', 'lockfileVersion', 'requires', 'packages'],
      package: ['version', 'resolved', 'integrity', 'dev', 'devOptional', 'optional', 'peer', 'engines', 'bin', 'dependencies', 'optionalDependencies', 'peerDependencies'],
      supportsWorkspaces: true,
      nestedDependencies: false,
      packagesMap: true
    }
  }
};

export const SCHEMA_DEFINITIONS = {
  lockfileV1: {
    type: 'object',
    required: ['name', 'version', 'lockfileVersion', 'dependencies'],
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
      lockfileVersion: { type: 'number', const: 1 },
      requires: { type: 'boolean' },
      dependencies: {
        type: 'object',
        patternProperties: {
          '.*': { $ref: '#/definitions/dependencyV1' }
        }
      }
    },
    definitions: {
      dependencyV1: {
        type: 'object',
        required: ['version'],
        properties: {
          version: { type: 'string' },
          resolved: { type: 'string', format: 'uri' },
          integrity: { type: 'string', pattern: '^(sha1|sha512)-' },
          dev: { type: 'boolean' },
          optional: { type: 'boolean' },
          requires: {
            type: 'object',
            patternProperties: {
              '.*': { type: 'string' }
            }
          },
          dependencies: {
            type: 'object',
            patternProperties: {
              '.*': { $ref: '#/definitions/dependencyV1' }
            }
          }
        }
      }
    }
  },
  lockfileV2: {
    type: 'object',
    required: ['name', 'version', 'lockfileVersion', 'packages'],
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
      lockfileVersion: { type: 'number', const: 2 },
      requires: { type: 'boolean' },
      packages: {
        type: 'object',
        patternProperties: {
          '.*': { $ref: '#/definitions/packageV2' }
        }
      },
      dependencies: {
        type: 'object',
        patternProperties: {
          '.*': { $ref: '#/definitions/dependencyV1' }
        }
      }
    },
    definitions: {
      packageV2: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          resolved: { type: 'string', format: 'uri' },
          integrity: { type: 'string', pattern: '^(sha1|sha512)-' },
          dev: { type: 'boolean' },
          devOptional: { type: 'boolean' },
          optional: { type: 'boolean' },
          peer: { type: 'boolean' },
          dependencies: {
            type: 'object',
            patternProperties: {
              '.*': { type: 'string' }
            }
          }
        }
      },
      dependencyV1: {
        type: 'object',
        required: ['version'],
        properties: {
          version: { type: 'string' },
          resolved: { type: 'string', format: 'uri' },
          integrity: { type: 'string', pattern: '^(sha1|sha512)-' },
          dev: { type: 'boolean' },
          optional: { type: 'boolean' },
          requires: {
            type: 'object',
            patternProperties: {
              '.*': { type: 'string' }
            }
          },
          dependencies: {
            type: 'object',
            patternProperties: {
              '.*': { $ref: '#/definitions/dependencyV1' }
            }
          }
        }
      }
    }
  },
  lockfileV3: {
    type: 'object',
    required: ['name', 'version', 'lockfileVersion', 'packages'],
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
      lockfileVersion: { type: 'number', const: 3 },
      requires: { type: 'boolean' },
      packages: {
        type: 'object',
        patternProperties: {
          '.*': { $ref: '#/definitions/packageV3' }
        }
      }
    },
    definitions: {
      packageV3: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          resolved: { type: 'string', format: 'uri' },
          integrity: { type: 'string', pattern: '^(sha1|sha512)-' },
          dev: { type: 'boolean' },
          optional: { type: 'boolean' },
          peer: { type: 'boolean' },
          dependencies: {
            type: 'object',
            patternProperties: {
              '.*': { type: 'string' }
            }
          }
        }
      }
    }
  }
};

export const DEPENDENCY_TYPES = {
  DEVELOPMENT: 'devDependencies',
  PEER: 'peerDependencies',
  OPTIONAL: 'optionalDependencies',
  PRODUCTION: 'dependencies'
};
