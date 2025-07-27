const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");

const configuration_workflow = () => {
  const cfg_base_url = getState().getConfig("base_url");
  return new Workflow({
    steps: [
      {
        name: "Apple Pay with PayPal",
        form: () =>
          new Form({
            labelCols: 3,
            blurb: !cfg_base_url
              ? "You should set the 'Base URL' configration property. "
              : "",
            fields: [
              {
                name: "client_id",
                label: "PayPal Client ID",
                type: "String",
                required: true,
              },
              {
                name: "client_secret",
                label: "PayPal Client Secret",
                type: "String",
                required: true,
              },
              {
                name: "environment",
                label: "Environment",
                type: "String",
                attributes: {
                  options: ["sandbox", "production"],
                },
                default: "sandbox",
              },
              {
                name: "merchant_domain_file",
                label: "Domain Verification File",
                type: "String",
                fieldview: "textarea",
                sublabel:
                  "Paste the contents of apple-developer-merchantid-domain-association",
              },
            ],
          }),
      },
    ],
  });
};

const actions = () => ({
  initiate_applepay: {
    configFields: async () => {
      const payViews = await View.find({});
      return [
        {
          name: "currency",
          label: "Currency",
          type: "String",
          default: "USD",
          required: true,
        },
        {
          name: "amount",
          label: "Amount",
          type: "Float",
          required: true,
        },
        {
          name: "applepay_button_view",
          label: "ApplePay Button View",
          type: "String",
          required: true,
          attributes: {
            options: payViews.map((f) => f.name),
          },
        },
      ];
    },
    run: async ({
      configuration: { applepay_button_view, currency, amount },
    }) => {
      return {
        goto: `http://localhost:3000/view/${applepay_button_view}?amount=${amount}&currency=${
          currency || "USD"
        }`,
      };
    },
  },
});

const viewtemplates = (pluginCfg) => [
  {
    name: "Apple Pay Button",
    display_state_form: false,
    configuration_workflow: () =>
      new Workflow({
        steps: [
          {
            name: "Button Settings",
            form: () =>
              new Form({
                fields: [
                  {
                    name: "button_style",
                    label: "Button Style",
                    type: "String",
                    attributes: {
                      options: ["black", "white", "white-outline"],
                    },
                    default: "black",
                  },
                  {
                    name: "button_type",
                    label: "Button Type",
                    type: "String",
                    attributes: {
                      options: [
                        "buy",
                        "donate",
                        "plain",
                        "check-out",
                        "set-up",
                        "book",
                      ],
                    },
                    default: "buy",
                  },
                ],
              }),
          },
        ],
      }),
    run: async (table_id, viewname, cfg, state, { req }) => {
      const csrfToken = req?.csrfToken();
      return `
        <html>
          <head>
            <style>
              .apple-pay-button {
                display: inline-block;
                -webkit-appearance: -apple-pay-button;
                -apple-pay-button-type: ${cfg.button_type || "buy"};
              }
              .apple-pay-button-black {
                -apple-pay-button-style: black;
              }
              .apple-pay-button-white {
                -apple-pay-button-style: white;
              }
              .apple-pay-button-white-outline {
                -apple-pay-button-style: white-outline;
              }
            </style>
            <script src="https://www.paypal.com/sdk/js?client-id="${
              pluginCfg.client_id
            }"&components=applepay"></script>
            <script src="https://applepay.cdn-apple.com/jsapi/v1/apple-pay-sdk.js"></script>
          </head>
          <body>
            Hello World! <br />
            <hr />
            <div class="apple-pay-button apple-pay-button-${
              cfg.button_style
            }"></div>

            <script>
              document
                .querySelector(".apple-pay-button")
                .addEventListener("click", async () => {
                  // Test Request
                  try {
                  const response = await fetch("/applepay/test_req", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "X-CSRF-Token": "${csrfToken || ""}",
                    },
                    body: JSON.stringify({
                      client_id: ${pluginCfg.client_id},
                      environment: "${pluginCfg.environment || "sandbox"}",
                    }),
                  });
                  
                  const data = await response.json();
                  console.log("Test request response:", data);
                  if (!window.ApplePaySession) {
                    alert("Apple Pay not available");
                    return;
                  }
                  console.log("Apple Pay Session available");
                  } catch (error) {
                    console.error("Test request failed:", error);
                    alert("Test request failed. Check console for details.");
                    return;
                  }
                  // Use PayPal as processor
                  const applepay = paypal.Applepay();
                  const config = await applepay.config();

                  if (!config.isEligible) {
                    alert("Apple Pay not eligible");
                    return;
                  }

                  const session = new ApplePaySession(3, {
                    countryCode: "US",
                    currencyCode: "${state.currency}",
                    merchantCapabilities: ["supports3DS"],
                    supportedNetworks: ["visa", "masterCard", "amex", "discover"],
                    total: {
                      label: "Store",
                      amount: "${state.amount || "10.00"}",
                    },
                  });

                  session.onvalidatemerchant = async (event) => {
                    try {
                      const validation = await applepay.validateMerchant({
                        validationUrl: event.validationURL,
                        displayName: "Store",
                      });
                      session.completeMerchantValidation(validation.merchantSession);
                    } catch (e) {
                      console.error("Validation failed", e);
                      session.abort();
                    }
                  };

                  session.onpaymentauthorized = async (event) => {
                    try {
                      // Create order
                      const order = await fetch("/applepay/create_order", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          amount: "10.00",
                          currency: "USD",
                        }),
                      }).then((res) => res.json());

                      // Confirm with PayPal
                      await applepay.confirmOrder({
                        orderId: order.id,
                        token: event.payment.token,
                      });

                      session.completePayment(ApplePaySession.STATUS_SUCCESS);
                      window.location.href = "/view/thankyou";
                    } catch (e) {
                      console.error("Payment failed", e);
                      session.completePayment(ApplePaySession.STATUS_FAILURE);
                    }
                  };

                  session.begin();
                });
            </script>
          </body>
        </html>
      `;
    },
  },
];

const routes = (pluginCfg) => [
  {
    url: "/.well-known/apple-developer-merchantid-domain-association",
    method: "get",
    callback: ({ res }) => {
      console.log(
        "ApplePay should run this endpoint automatically. Not yet checked this though."
      );
      res.type("text/plain").send(pluginCfg.merchant_domain_file || "");
    },
  },
  {
    url: "/test",
    method: "get",
    callback: async ({ res }) => {
      res.send({
        message: "Test request successful",
        client_id: pluginCfg.client_id,
        environment: pluginCfg.environment,
      });
    },
  },
  {
    url: "/applepay/test_req",
    method: "post",
    callback: async ({ res }) => {
      // console.log({ req });
      res.send({
        message: "Test request successful",
        client_id: pluginCfg.client_id,
        environment: pluginCfg.environment,
      });
    },
  },
  {
    url: "/applepay/create_order",
    method: "post",
    callback: async ({ req, res }) => {
      const endpoint =
        pluginCfg.environment === "sandbox"
          ? "https://api-m.sandbox.paypal.com"
          : "https://api-m.paypal.com";

      try {
        // Getting access token
        const auth = Buffer.from(
          `${pluginCfg.client_id}:${pluginCfg.client_secret}`
        ).toString("base64");
        const { access_token } = await fetch(`${endpoint}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${auth}`,
          },
          body: "grant_type=client_credentials",
        }).then((res) => res.json());

        // Creatinng order
        const order = await fetch(`${endpoint}/v2/checkout/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${access_token}`,
          },
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
              {
                amount: {
                  currency_code: req.body.currency,
                  value: req.body.amount,
                },
              },
            ],
          }),
        }).then((res) => res.json());

        res.send(order);
      } catch (e) {
        console.error("Order creation failed", e);
        res.status(500).send({ error: "Order creation failed" });
      }
    },
  },
];

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,
  actions,
  viewtemplates,
  routes,
};
