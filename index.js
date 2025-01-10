const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const User = require("@saltcorn/data/models/user");
const {
  eval_expression,
  add_free_variables_to_joinfields,
  freeVariables,
} = require("@saltcorn/data/models/expression");
const { getState, features } = require("@saltcorn/data/db/state");
const { interpolate } = require("@saltcorn/data/utils");

const configuration_workflow = () => {
  const cfg_base_url = getState().getConfig("base_url");

  return new Workflow({
    steps: [
      {
        name: "ApplePay configuration",
        form: () =>
          new Form({
            labelCols: 3,
            blurb: !cfg_base_url
              ? "You should set the 'Base URL' configration property. "
              : "",
            fields: [
              {
                label: "Merchant domain verification",
                sublabel:
                  "Contents of the merchant domain verification file to be hosted at .well-known/apple-developer-merchantid-domain-association",
                type: "String",
                name: "merchant_verification_contents",
                fieldview: "textarea",
              },
              {
                name: "mode",
                label: "Mode",
                type: "String",
                required: true,
                attributes: { options: ["Sandbox", "Live"] },
              },
              {
                name: "client_id",
                label: "Client ID",
                type: "String",
                required: true,
              },
              {
                name: "client_secret",
                label: "Client secret",
                type: "String",
                required: true,
              },
            ],
          }),
      },
    ],
  });
};

const actions = () => ({
  applepay_create_payment: {
    configFields: async ({ table }) => {
      const fields = table ? await table.getFields() : [];

      const cbviews = await View.find({ viewtemplate: "ApplePay Callback" });
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
          attributes: {
            options: amount_options,
          },
        },
        {
          name: "amount_formula",
          label: "Amount formula",
          type: "String",
          required: true,
          fieldview: "textarea",
          class: "validate-expression",
          showIf: { amount_field: "Formula" },
        },
        {
          name: "currency",
          label: "Currency",
          type: "String",
          sublabel:
            "3 Letter currency code e.g. USD. Use interpolations {{ }} to access fields",
          required: true,
        },
        {
          name: "callback_view",
          label: "Callback view",
          type: "String",
          required: true,
          attributes: {
            options: cbviews.map((f) => f.name),
          },
        },
      ];
    },
    run: async ({
      table,
      req,
      user,
      row,
      configuration: { currency, amount_field, amount_formula, callback_view },
    }) => {
      let amount;
      console.log(
        "amount val",
        amount_field,
        row[amount_field],
        typeof row[amount_field],
        row
      );

      if (amount_field === "Formula") {
        const joinFields = {};
        add_free_variables_to_joinfields(
          freeVariables(amount_formula),
          joinFields,
          table.fields
        );
        let row_eval;
        if (Object.keys(joinFields).length > 0)
          row_eval = (
            await table.getJoinedRows({
              where: { id: row.id },
              joinFields,
            })
          )[0];
        else row_eval = row;

        amount = eval_expression(amount_formula, row_eval, req?.user).toFixed(
          2
        );
      } else if (amount_field.includes(".")) {
        const amt_fk_field = table.getField(amount_field);
        const amt_table = Table.findOne(amt_fk_field.table_id);
        const amt_row = await amt_table.getRow({
          [amt_table.pk_name]: row[amount_field.split(".")[0]],
        });
        amount = (+amt_row[amt_fk_field.name]).toFixed(2);
      } else amount = (+row[amount_field]).toFixed(2);
      let use_currency = interpolate(currency, row, user);
      const cfg_base_url = getState().getConfig("base_url");
      const cb_url = `${cfg_base_url}view/${callback_view}?id=${row.id}&amt=${amount}&ccy=${use_currency}`;
      // from https://www.geeksforgeeks.org/how-to-integrate-paypal-in-node/
      const create_payment_json = {
        intent: "sale",
        payer: {
          payment_method: "paypal",
        },
        redirect_urls: {
          return_url: cb_url,
          cancel_url: cb_url,
        },
        transactions: [
          {
            /*  item_list: {
              items: [
                {
                  name: "Red Sox Hat",
                  sku: "001",
                  price: "25.00",
                  currency: "USD",
                  quantity: 1,
                },
              ],
            },*/
            amount: {
              currency: use_currency,
              total: amount,
            },
            description: "Hat for the best team ever",
          },
        ],
      };
    },
  },
});

const viewtemplates = () => [
  {
    name: "ApplePay Callback",
    display_state_form: false,
    configuration_workflow: () =>
      new Workflow({
        steps: [
          {
            name: "Callback configuration",
            disablePreview: true,
            form: async (context) => {
              const table = Table.findOne({ id: context.table_id });
              const views = await View.find({ table_id: table.id });
              return new Form({
                fields: [
                  {
                    name: "paid_field",
                    label: "Paid field",
                    type: "String",
                    sublabel:
                      "Optionally, a Boolean field that will be set to true if paid",
                    attributes: {
                      options: table.fields
                        .filter((f) => f.type?.name === "Bool")
                        .map((f) => f.name),
                    },
                  },
                  {
                    name: "success_view",
                    label: "Success view",
                    type: "String",
                    required: true,
                    attributes: {
                      options: views
                        .filter((v) => v.name !== context.viewname)
                        .map((v) => v.name),
                    },
                  },

                  {
                    name: "failure_view",
                    label: "Failure view",
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
    get_state_fields: () => [],
    run: async (
      table_id,
      viewname,
      {
        reference_id_field,
        paid_field,
        cancelled_view,
        success_view,
        processing_view,
        failure_view,
      },
      state,
      { req, res }
    ) => {
      console.log("state", state);
      const table = Table.findOne({ id: table_id });
      const row = await table.getRow({
        id: state.id,
      });
      const upd = {};

      const payerId = state.PayerID;
      const paymentId = state.paymentId;

      const execute_payment_json = {
        payer_id: payerId,
        transactions: [
          {
            amount: {
              currency: state.ccy,
              total: state.amt,
            },
          },
        ],
      };

      return "Something apple here";
    },
  },
];

const routes = (config) => {
  return [
    {
      url: "/.well-known/apple-developer-merchantid-domain-association.txt",
      method: "get",
      callback: async ({ req, res }) => {
        if (config?.merchant_verification_contents)
          res
            .status(200)
            .text(
              config?.merchant_verification_contents ||
                "missing merchant verification content"
            );
        else res.status(400).text("missing merchant verification content");
      },
    },
  ];
};

module.exports = {
  sc_plugin_api_version: 1,
  routes,
  configuration_workflow,
  actions,
  viewtemplates,
};
