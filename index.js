const fs = require("fs");
const https = require("https");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const {
  eval_expression,
  add_free_variables_to_joinfields,
  freeVariables,
} = require("@saltcorn/data/models/expression");
const { getState } = require("@saltcorn/data/db/state");
const { interpolate } = require("@saltcorn/data/utils");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Apple Pay Configuration",
        form: () =>
          new Form({
            labelCols: 3,
            fields: [
              {
                name: "merchant_id",
                label: "Merchant Identifier",
                type: "String",
                required: true,
                sublabel:
                  "Copy from Apple Developer → Certificates, IDs & Profiles",
              },
              {
                name: "display_name",
                label: "Display Name",
                type: "String",
                required: true,
                sublabel: "Shown to customers in the Apple Pay sheet",
              },
              {
                name: "supported_networks",
                label: "Supported Networks",
                type: "String",
                attributes: {
                  options: ["visa", "masterCard", "amex", "discover"],
                  multiple: true,
                },
                required: true,
              },
              {
                name: "merchant_domain_file",
                label: "Domain Verification File",
                type: "String",
                fieldview: "textarea",
                sublabel:
                  "Paste the contents of apple-developer-merchantid-domain-association",
              },
              {
                name: "identity_cert_path",
                label: "Identity PKCS#12 (.p12 / .pfx) path",
                type: "String",
                required: true,
                sublabel:
                  "Absolute path on server to the Merchant Identity certificate bundle",
              },
              {
                name: "identity_cert_password",
                label: "Identity cert password",
                type: "String",
                required: true,
              },
            ],
          }),
      },
    ],
  });

const actions = () => ({
  applepay_create_session: {
    configFields: async ({ table }) => {
      const fields = table ? await table.getFields() : [];
      const amount_options = fields
        .filter((f) => ["Float", "Integer", "Money"].includes(f.type?.name))
        .map((f) => f.name);
      amount_options.push("Formula");

      return [
        {
          name: "amount_field",
          label: "Amount field",
          type: "String",
          required: true,
          attributes: { options: amount_options },
        },
        {
          name: "amount_formula",
          label: "Amount formula",
          type: "String",
          fieldview: "textarea",
          class: "validate-expression",
          showIf: { amount_field: "Formula" },
        },
        {
          name: "currency",
          label: "Currency (ISO 4217)",
          type: "String",
          default: "USD",
          required: true,
        },
        {
          name: "order_id_field",
          label: "Order ID field",
          type: "String",
          required: true,
          attributes: { options: fields.map((f) => f.name) },
        },
      ];
    },

    run: async ({
      table,
      req,
      row,
      configuration: { currency, amount_field, amount_formula, order_id_field },
    }) => {
      let amount;

      if (amount_field === "Formula") {
        const joinFields = {};
        add_free_variables_to_joinfields(
          freeVariables(amount_formula),
          joinFields,
          table.fields
        );
        const row_eval =
          Object.keys(joinFields).length > 0
            ? (
                await table.getJoinedRows({
                  where: { id: row.id },
                  joinFields,
                })
              )[0]
            : row;
        amount = parseFloat(
          eval_expression(amount_formula, row_eval, req?.user)
        ).toFixed(2);
      } else if (amount_field.includes(".")) {
        const fk_field = table.getField(amount_field);
        const fk_table = Table.findOne(fk_field.table_id);
        const fk_row = await fk_table.getRow({
          [fk_table.pk_name]: row[amount_field.split(".")[0]],
        });
        amount = (+fk_row[fk_field.name]).toFixed(2);
      } else {
        amount = (+row[amount_field]).toFixed(2);
      }

      return {
        type: "applepay",
        amount,
        currency: interpolate(currency, row),
        order_id: row[order_id_field],
        row_id: row.id,
      };
    },
  },
});

const viewtemplates = () => [
  {
    name: "Apple Pay Button",
    display_state_form: false,
    configuration_workflow: () =>
      new Workflow({
        steps: [
          {
            name: "Button Configuration",
            form: () =>
              new Form({
                fields: [
                  {
                    name: "button_style",
                    label: "Button style",
                    type: "String",
                    attributes: {
                      options: ["black", "white", "white-outline"],
                    },
                    default: "black",
                  },
                  {
                    name: "button_type",
                    label: "Button type",
                    type: "String",
                    attributes: {
                      options: ["plain", "buy", "donate", "checkout"],
                    },
                    default: "buy",
                  },
                ],
              }),
          },
        ],
      }),

    run: async (table_id, viewname, configuration, state, { req }) => {
      const cfg = getState().getConfig("applepay") || {};

      return `
        <script src="/plugins/public/apple-pay-sdk.js"></script>
        <script id="applepay-config" type="application/json">
        ${JSON.stringify({
          merchant_id: cfg.merchant_id,
          display_name: cfg.display_name,
          supported_networks: cfg.supported_networks,
          currency: configuration.currency || "USD",
          locale: req?.language || "en-US",
        })}
        </script>

        <apple-pay-button
          buttonstyle="${configuration.button_style || "black"}"
          type="${configuration.button_type || "buy"}"
          locale="${req?.language || "en-US"}"
        ></apple-pay-button>
        <script src="/plugins/public/applepay.js"></script>`;
      // https://applepaydemo.apple.com/apple-pay-js-api, apple paybutton config + cdn link for js script
    },
  },

  {
    name: "Apple Pay Callback",
    display_state_form: false,
    configuration_workflow: () =>
      new Workflow({
        steps: [
          {
            name: "Callback Configuration",
            form: async (context) => {
              const table = Table.findOne({ id: context.table_id });
              const views = await View.find({ table_id: table.id });

              return new Form({
                fields: [
                  {
                    name: "paid_field",
                    label: "Paid field (Bool)",
                    type: "String",
                    attributes: {
                      options: table.fields
                        .filter((f) => f.type?.name === "Bool")
                        .map((f) => f.name),
                    },
                  },
                  {
                    name: "success_view",
                    label: "Redirect to view",
                    type: "String",
                    required: true,
                    attributes: {
                      options: views
                        .filter((v) => v.name !== context.viewname)
                        .map((v) => v.name),
                    },
                  },
                ],
              });
            },
          },
        ],
      }),

    run: async (
      table_id,
      viewname,
      { paid_field, success_view },
      state,
      { req }
    ) => {
      if (state.status === "success" && paid_field) {
        const table = Table.findOne({ id: table_id });
        await table.updateRow({ [paid_field]: true }, state.row_id);
      }
      return { goto: `/view/${success_view}?id=${state.row_id}` };
    },
  },
];

const routes = (config) => [
  {
    url: "/.well-known/apple-developer-merchantid-domain-association",
    method: "get",
    callback: ({ res }) => {
      res.type("text/plain").send(config.merchant_domain_file || "");
    },
  },
  {
    url: "/applepay/validate",
    method: "post",
    callback: async ({ req, res }) => {
      const { validationURL } = req.body;
      const cfg = getState().getConfig("applepay");

      const p12 = fs.readFileSync(cfg.identity_cert_path);
      const tlsAgent = new https.Agent({
        pfx: p12,
        passphrase: cfg.identity_cert_password,
      });

      const postData = JSON.stringify({
        merchantIdentifier: cfg.merchant_id,
        domainName: req.hostname,
        displayName: cfg.display_name,
      });

      const requestOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        agent: tlsAgent,
      };

      const appleRes = await new Promise((resolve, reject) => {
        const apReq = https.request(validationURL, requestOpts, (resp) => {
          let data = "";
          resp.on("data", (chunk) => (data += chunk));
          resp.on("end", () =>
            resp.statusCode === 200
              ? resolve(JSON.parse(data))
              : reject(new Error(`Apple response ${resp.statusCode}`))
          );
        });
        apReq.on("error", reject);
        apReq.write(postData);
        apReq.end();
      });

      res.send(appleRes);
    },
  },
  {
    url: "/applepay/process",
    method: "post",
    callback: async ({ req, res }) => {
      const { token, row_id, amount, currency } = req.body;

      // While testing, might have to forward to a PSP that supports Apple Pay eg srtripe or adyen, incase appple pay is requires an external PSP

      res.send({ status: "success", row_id });
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
