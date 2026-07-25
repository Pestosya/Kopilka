const test = require("node:test");
const assert = require("node:assert/strict");
const {
  roundMoney,
  calculateAccountBalance,
  calculateAccountsTotal,
  recurringMonthlyAmount,
  annuityPayment,
  simulateDebtStrategy
} = require("../modules/finance.js");

test("остаток счёта учитывает операции и переводы", () => {
  const account = { id: "main", includeInTotal: true };
  const operations = [
    { accountId: "main", type: "initial_balance", amount: 10000 },
    { accountId: "main", type: "income", amount: 5000 },
    { accountId: "main", type: "expense", amount: 1200 },
    { accountId: "other", type: "expense", amount: 9999 }
  ];
  const transfers = [
    { fromAccountId: "main", toAccountId: "savings", amount: 2000 },
    { fromAccountId: "cash", toAccountId: "main", amount: 300 }
  ];
  assert.equal(calculateAccountBalance(account, operations, transfers), 12100);
});

test("перевод между счетами не меняет общий баланс", () => {
  const accounts = [
    { id: "one", includeInTotal: true },
    { id: "two", includeInTotal: true }
  ];
  const operations = [
    { accountId: "one", type: "initial_balance", amount: 8000 },
    { accountId: "two", type: "initial_balance", amount: 2000 }
  ];
  const transfer = [{ fromAccountId: "one", toAccountId: "two", amount: 1500 }];
  const total = calculateAccountsTotal(accounts, operations, transfer);
  assert.equal(total, 10000);
});

test("комиссия перевода списывается только со счёта отправителя", () => {
  const operations = [
    { accountId: "one", type: "initial_balance", amount: 10000 },
    { accountId: "two", type: "initial_balance", amount: 0 }
  ];
  const transfers = [{ fromAccountId: "one", toAccountId: "two", amount: 1500, fee: 50 }];
  assert.equal(calculateAccountBalance({ id: "one" }, operations, transfers), 8450);
  assert.equal(calculateAccountBalance({ id: "two" }, operations, transfers), 1500);
  assert.equal(calculateAccountsTotal([{ id: "one" }, { id: "two" }], operations, transfers), 9950);
});

test("openingBalance и currentBalance не являются источниками баланса", () => {
  const account = { id: "main", openingBalance: 999999, currentBalance: 123 };
  const operations = [{ accountId: "main", type: "initial_balance", amount: 7000 }];
  assert.equal(calculateAccountBalance(account, operations, []), 7000);
});

test("кредитный лимит не прибавляется к собственным средствам", () => {
  const accounts = [
    { id: "cash", type: "cash", includeInTotal: true },
    { id: "credit", type: "credit", includeInTotal: true, creditLimit: 100000 }
  ];
  const operations = [
    { accountId: "cash", type: "initial_balance", amount: 50000 },
    { accountId: "credit", type: "initial_balance", amount: -35000 }
  ];
  assert.equal(calculateAccountsTotal(accounts, operations, []), 15000);
});

test("регулярные платежи приводятся к месячной сумме", () => {
  assert.equal(roundMoney(recurringMonthlyAmount({ amount: 1200, frequency: "yearly" })), 100);
  assert.equal(roundMoney(recurringMonthlyAmount({ amount: 300, frequency: "weekly" })), 1300);
  assert.equal(recurringMonthlyAmount({ amount: 900, frequency: "monthly" }), 900);
});

test("аннуитетный платёж рассчитывается для ставки и нулевой ставки", () => {
  assert.equal(annuityPayment(120000, 0, 12), 10000);
  assert.equal(annuityPayment(100000, 12, 12), 8884.88);
});

test("снежный ком и лавина выбирают разные первые долги", () => {
  const debts = [
    { id: "small", name: "Небольшой долг", balance: 10000, rate: 5, payment: 1000 },
    { id: "expensive", name: "Дорогой кредит", balance: 50000, rate: 20, payment: 1500 }
  ];
  const snowball = simulateDebtStrategy(debts, "snowball", 2000);
  const avalanche = simulateDebtStrategy(debts, "avalanche", 2000);
  assert.equal(snowball.priorityOrder[0].id, "small");
  assert.equal(avalanche.priorityOrder[0].id, "expensive");
  assert.ok(avalanche.totalInterest < snowball.totalInterest);
  assert.equal(snowball.complete, true);
  assert.equal(avalanche.complete, true);
});
