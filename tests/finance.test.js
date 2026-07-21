const test = require("node:test");
const assert = require("node:assert/strict");
const {
  roundMoney,
  calculateAccountBalance,
  recurringMonthlyAmount,
  annuityPayment,
  simulateDebtStrategy
} = require("../modules/finance.js");

test("остаток счёта учитывает операции и переводы", () => {
  const account = { id: "main", openingBalance: 10000 };
  const operations = [
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
    { id: "one", openingBalance: 8000 },
    { id: "two", openingBalance: 2000 }
  ];
  const transfer = [{ fromAccountId: "one", toAccountId: "two", amount: 1500 }];
  const total = accounts.reduce(
    (sum, account) => sum + calculateAccountBalance(account, [], transfer),
    0
  );
  assert.equal(total, 10000);
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
