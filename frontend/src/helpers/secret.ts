import path from "path";

import { decryptSymmetric } from "@app/components/utilities/cryptography/crypto";
import { fetchProjectEncryptedSecrets } from "@app/hooks/api/secrets/queries";

const INTERPOLATION_SYNTAX_REG = /\${([^}]+)}/g;
export const interpolateSecrets = ({
  projectId,
  secretEncKey
}: {
  projectId: string;
  secretEncKey: string;
}) => {
  const fetchSecretsCrossEnv = () => {
    const fetchCache: Record<string, Record<string, string>> = {};

    return async (secRefEnv: string, secRefPath: string[], secRefKey: string) => {
      const secRefPathUrl = path.join("/", ...secRefPath);
      const uniqKey = `${secRefEnv}-${secRefPathUrl}`;

      if (fetchCache?.[uniqKey]) {
        return fetchCache[uniqKey][secRefKey];
      }

      // get secrets by projectId, env, path
      const encryptedSecrets = await fetchProjectEncryptedSecrets({
        workspaceId: projectId,
        environment: secRefEnv,
        secretPath: secRefPathUrl
      });

      const decryptedSec = encryptedSecrets.reduce<Record<string, string>>((prev, secret) => {
        const secretKey = decryptSymmetric({
          ciphertext: secret.secretKeyCiphertext,
          iv: secret.secretKeyIV,
          tag: secret.secretKeyTag,
          key: secretEncKey
        });
        const secretValue = decryptSymmetric({
          ciphertext: secret.secretValueCiphertext,
          iv: secret.secretValueIV,
          tag: secret.secretValueTag,
          key: secretEncKey
        });

        // eslint-disable-next-line
        prev[secretKey] = secretValue;
        return prev;
      }, {});

      fetchCache[uniqKey] = decryptedSec;

      return fetchCache[uniqKey][secRefKey];
    };
  };

  const recursivelyExpandSecret = async (
    expandedSec: Record<string, string>,
    interpolatedSec: Record<string, string>,
    fetchCrossEnv: (env: string, secPath: string[], secKey: string) => Promise<string>,
    recursionChainBreaker: Record<string, boolean>,
    key: string
  ) => {
    if (expandedSec?.[key] !== undefined) {
      return expandedSec[key];
    }
    if (recursionChainBreaker?.[key]) {
      return "";
    }
    // eslint-disable-next-line
    recursionChainBreaker[key] = true;

    let interpolatedValue = interpolatedSec[key];
    if (!interpolatedValue) {
      // eslint-disable-next-line no-console
      console.error(`Couldn't find referenced value - ${key}`);
      return "";
    }

    const refs = interpolatedValue.match(INTERPOLATION_SYNTAX_REG);
    if (refs) {
      await Promise.all(
        refs.map(async (interpolationSyntax) => {
          const interpolationKey = interpolationSyntax.slice(2, interpolationSyntax.length - 1);
          const entities = interpolationKey.trim().split(".");

          if (entities.length === 1) {
            const val = await recursivelyExpandSecret(
              expandedSec,
              interpolatedSec,
              fetchCrossEnv,
              recursionChainBreaker,
              interpolationKey
            );
            if (val) {
              interpolatedValue = interpolatedValue.replaceAll(interpolationSyntax, val);
            }
            return;
          }

          if (entities.length > 1) {
            const secRefEnv = entities[0];
            const secRefPath = entities.slice(1, entities.length - 1);
            const secRefKey = entities[entities.length - 1];

            const val = await fetchCrossEnv(secRefEnv, secRefPath, secRefKey);
            if (val) {
              interpolatedValue = interpolatedValue.replaceAll(interpolationSyntax, val);
            }
          }
        })
      );
    }

    // eslint-disable-next-line
    expandedSec[key] = interpolatedValue;
    return interpolatedValue;
  };

  // used to convert multi line ones to quotes ones with \n
  const formatMultiValueEnv = (val?: string) => {
    if (!val) return "";
    if (!val.match("\n")) return val;
    return `"${val.replace(/\n/g, "\\n")}"`;
  };

  const expandSecrets = async (
    secrets: Record<string, { value: string; comment?: string; skipMultilineEncoding?: boolean }>
  ) => {
    const expandedSec: Record<string, string> = {};
    const interpolatedSec: Record<string, string> = {};

    const crossSecEnvFetch = fetchSecretsCrossEnv();

    Object.keys(secrets).forEach((key) => {
      if (secrets[key].value.match(INTERPOLATION_SYNTAX_REG)) {
        interpolatedSec[key] = secrets[key].value;
      } else {
        expandedSec[key] = secrets[key].value;
      }
    });

    await Promise.all(
      Object.keys(secrets).map(async (key) => {
        if (expandedSec?.[key]) {
          // should not do multi line encoding if user has set it to skip
          // eslint-disable-next-line
          secrets[key].value = secrets[key].skipMultilineEncoding
            ? expandedSec[key]
            : formatMultiValueEnv(expandedSec[key]);
          return;
        }

        // this is to avoid recursion loop. So the graph should be direct graph rather than cyclic
        // so for any recursion building if there is an entity two times same key meaning it will be looped
        const recursionChainBreaker: Record<string, boolean> = {};
        const expandedVal = await recursivelyExpandSecret(
          expandedSec,
          interpolatedSec,
          crossSecEnvFetch,
          recursionChainBreaker,
          key
        );

        // eslint-disable-next-line
        secrets[key].value = secrets[key].skipMultilineEncoding
          ? expandedVal
          : formatMultiValueEnv(expandedVal);
      })
    );

    return secrets;
  };
  return expandSecrets;
};
