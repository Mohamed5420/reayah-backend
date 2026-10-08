import { env } from '../../../config/env.config';
import { GatewayName } from '../../../interfaces/IPayment';
import { FakeGateway } from './fake.gateway';
import { PaymobGateway } from './paymob.gateway';
import type { PaymentGateway } from './payment-gateway';

export * from './payment-gateway';

let gateways: Map<GatewayName, PaymentGateway> | null = null;

/** Gateways this deployment can talk to (Paymob when its keys are set; the fake one outside production). */
const build = () => {
  const map = new Map<GatewayName, PaymentGateway>();
  const p = env.payments.paymob;
  if (p.secretKey && p.publicKey && p.hmacSecret) {
    map.set(
      GatewayName.PAYMOB,
      new PaymobGateway({
        apiUrl: p.apiUrl,
        checkoutUrl: p.checkoutUrl,
        secretKey: p.secretKey,
        publicKey: p.publicKey,
        hmacSecret: p.hmacSecret,
        integrations: { card: p.cardIntegrationId, wallet: p.walletIntegrationId },
      }),
    );
  }
  if (!env.isProduction) map.set(GatewayName.FAKE, new FakeGateway());
  return map;
};

export const gatewayByName = (name: string): PaymentGateway | undefined => {
  gateways ??= build();
  return gateways.get(name as GatewayName);
};

/** The gateway new payments use (`PAYMENT_GATEWAY`), or undefined when it isn't configured. */
export const activeGateway = (): PaymentGateway | undefined => gatewayByName(env.payments.gateway);

/** Tests: swap in a gateway instance. */
export const setGatewayForTests = (gateway: PaymentGateway) => {
  gateways ??= build();
  gateways.set(gateway.name, gateway);
};
