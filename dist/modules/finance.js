(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.KopilkaFinance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function roundMoney(value) {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  const ANALYTICS_OPERATION_TYPES = new Set(["income", "expense", "fee", "refund"]);

  function operationBalanceImpact(operation) {
    const amount = Number(operation?.amount || 0);
    if (operation?.type === "income" || operation?.type === "initial_balance") return amount;
    if (operation?.type === "expense" || operation?.type === "fee") return -Math.abs(amount);
    if (operation?.type === "refund") return Math.abs(amount);
    if (operation?.type === "balance_adjustment") return amount;
    return 0;
  }

  function operationAffectsAnalytics(operation) {
    return ANALYTICS_OPERATION_TYPES.has(operation?.type);
  }

  function operationAnalyticsImpact(operation) {
    if (!operationAffectsAnalytics(operation)) return { income: 0, expense: 0 };
    const amount = Math.abs(Number(operation?.amount || 0));
    if (operation?.type === "income") return { income: amount, expense: 0 };
    if (operation?.type === "refund") return { income: 0, expense: -amount };
    return { income: 0, expense: amount };
  }

  function transferFee(transfer) {
    return Math.max(0, Number(transfer?.fee || 0));
  }

  function calculateAccountBalance(account, operations = [], transfers = []) {
    if (!account) return 0;
    const operationsTotal = operations.reduce((sum, operation) => {
      if (operation.accountId !== account.id) return sum;
      return sum + operationBalanceImpact(operation);
    }, 0);
    const transfersTotal = transfers.reduce((sum, transfer) => {
      if (transfer.toAccountId === account.id) return sum + Number(transfer.amount || 0);
      if (transfer.fromAccountId === account.id) return sum - Number(transfer.amount || 0) - transferFee(transfer);
      return sum;
    }, 0);
    return roundMoney(operationsTotal + transfersTotal);
  }

  function accountIncludedInTotal(account) {
    return Boolean(account) && account.isArchived !== true && account.includeInTotal !== false;
  }

  function calculateAccountsTotal(accounts = [], operations = [], transfers = []) {
    return roundMoney((accounts || []).reduce((sum, account) => {
      if (!accountIncludedInTotal(account)) return sum;
      return sum + calculateAccountBalance(account, operations, transfers);
    }, 0));
  }

  function creditDebt(account, operations = [], transfers = []) {
    return roundMoney(Math.max(0, -calculateAccountBalance(account, operations, transfers)));
  }

  function creditOverpayment(account, operations = [], transfers = []) {
    return roundMoney(Math.max(0, calculateAccountBalance(account, operations, transfers)));
  }

  function availableCredit(account, operations = [], transfers = []) {
    return roundMoney(Math.max(0, Number(account?.creditLimit || 0) + calculateAccountBalance(account, operations, transfers)));
  }

  function calculateTransferFeesTotal(transfers = [], predicate = () => true) {
    return roundMoney((transfers || []).reduce((sum, transfer) => {
      if (!predicate(transfer)) return sum;
      return sum + transferFee(transfer);
    }, 0));
  }

  function recurringMonthlyAmount(item) {
    const amount = Number(item?.amount || 0);
    if (item?.frequency === "weekly") return amount * 52 / 12;
    if (item?.frequency === "yearly") return amount / 12;
    return amount;
  }

  function annuityPayment(balance, annualRate, periods) {
    const principal = Math.max(0, Number(balance || 0));
    const count = Math.max(1, Number(periods || 1));
    const rate = Math.max(0, Number(annualRate || 0)) / 100 / 12;
    if (rate === 0) return roundMoney(principal / count);
    const factor = Math.pow(1 + rate, count);
    return roundMoney(principal * rate * factor / (factor - 1));
  }

  function simulateDebtStrategy(debts, strategy = "avalanche", extraPayment = 0, maxMonths = 600) {
    const items = (debts || [])
      .filter(debt => Number(debt.balance || 0) > 0)
      .map(debt => ({
        id: debt.id,
        name: debt.name || "Долг",
        balance: Number(debt.balance || 0),
        rate: Math.max(0, Number(debt.rate || 0)),
        payment: Math.max(0, Number(debt.payment || 0))
      }));
    const payoffOrder = [];
    let months = 0;
    let totalInterest = 0;
    let totalPaid = 0;

    function activeItems() {
      return items.filter(item => item.balance > 0.005);
    }

    function priority(a, b) {
      if (strategy === "snowball") return a.balance - b.balance || b.rate - a.rate;
      return b.rate - a.rate || a.balance - b.balance;
    }

    const priorityOrder = [...items].sort(priority).map(item => ({
      id: item.id,
      name: item.name
    }));

    while (activeItems().length && months < maxMonths) {
      months += 1;
      activeItems().forEach(item => {
        const interest = item.balance * item.rate / 100 / 12;
        item.balance += interest;
        totalInterest += interest;
      });

      activeItems().forEach(item => {
        const fallbackPayment = Math.max(item.balance / 36, item.balance * item.rate / 100 / 12 + 1);
        const payment = Math.min(item.balance, item.payment > 0 ? item.payment : fallbackPayment);
        item.balance -= payment;
        totalPaid += payment;
        if (item.balance <= 0.005 && !payoffOrder.some(entry => entry.id === item.id)) {
          item.balance = 0;
          payoffOrder.push({ id: item.id, name: item.name, month: months });
        }
      });

      let extra = Math.max(0, Number(extraPayment || 0));
      while (extra > 0.005 && activeItems().length) {
        const target = [...activeItems()].sort(priority)[0];
        const payment = Math.min(extra, target.balance);
        target.balance -= payment;
        extra -= payment;
        totalPaid += payment;
        if (target.balance <= 0.005 && !payoffOrder.some(entry => entry.id === target.id)) {
          target.balance = 0;
          payoffOrder.push({ id: target.id, name: target.name, month: months });
        }
      }
    }

    return {
      strategy,
      months,
      totalInterest: roundMoney(totalInterest),
      totalPaid: roundMoney(totalPaid),
      priorityOrder,
      payoffOrder,
      remainingBalance: roundMoney(activeItems().reduce((sum, item) => sum + item.balance, 0)),
      complete: activeItems().length === 0
    };
  }

  return {
    roundMoney,
    operationBalanceImpact,
    operationAffectsAnalytics,
    operationAnalyticsImpact,
    transferFee,
    calculateAccountBalance,
    calculateAccountsTotal,
    calculateTransferFeesTotal,
    creditDebt,
    creditOverpayment,
    availableCredit,
    recurringMonthlyAmount,
    annuityPayment,
    simulateDebtStrategy
  };
});
