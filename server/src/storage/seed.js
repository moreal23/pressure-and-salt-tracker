function daysAgo(days) {
  const date = new Date()
  date.setHours(8, 0, 0, 0)
  date.setDate(date.getDate() - days)
  return date
}

function withTime(date, hour, minute) {
  const next = new Date(date)
  next.setHours(hour, minute, 0, 0)
  return next.toISOString()
}

function createSeedData() {
  return {
    settings: {
      sodiumGoalMg: 2300,
    },
    bloodPressureLogs: [
      {
        id: 'bp-1',
        systolic: 132,
        diastolic: 84,
        pulse: 75,
        notes: 'Morning reading after breakfast.',
        recordedAt: withTime(daysAgo(0), 8, 15),
      },
      {
        id: 'bp-2',
        systolic: 128,
        diastolic: 82,
        pulse: 71,
        notes: 'Light walk before reading.',
        recordedAt: withTime(daysAgo(1), 18, 30),
      },
      {
        id: 'bp-3',
        systolic: 135,
        diastolic: 86,
        pulse: 77,
        notes: 'Higher stress workday.',
        recordedAt: withTime(daysAgo(2), 19, 10),
      },
      {
        id: 'bp-4',
        systolic: 126,
        diastolic: 80,
        pulse: 69,
        notes: 'Took medication on schedule.',
        recordedAt: withTime(daysAgo(4), 7, 50),
      },
      {
        id: 'bp-5',
        systolic: 129,
        diastolic: 81,
        pulse: 72,
        notes: 'Evening reading.',
        recordedAt: withTime(daysAgo(5), 20, 5),
      },
    ],
    foodLogs: [
      {
        id: 'food-1',
        foodName: 'Turkey sandwich',
        servingSize: '1 sandwich',
        sodiumMg: 780,
        mealType: 'Meal',
        barcode: '',
        loggedAt: withTime(daysAgo(0), 12, 30),
      },
      {
        id: 'food-2',
        foodName: 'Greek yogurt',
        servingSize: '1 cup',
        sodiumMg: 95,
        mealType: 'Snack',
        barcode: '',
        loggedAt: withTime(daysAgo(0), 15, 15),
      },
      {
        id: 'food-3',
        foodName: 'Canned soup',
        servingSize: '1 bowl',
        sodiumMg: 920,
        mealType: 'Scan',
        barcode: '041196910503',
        loggedAt: withTime(daysAgo(0), 18, 45),
      },
      {
        id: 'food-4',
        foodName: 'Oatmeal',
        servingSize: '1 bowl',
        sodiumMg: 150,
        mealType: 'Meal',
        barcode: '',
        loggedAt: withTime(daysAgo(1), 8, 10),
      },
      {
        id: 'food-5',
        foodName: 'Frozen entree',
        servingSize: '1 tray',
        sodiumMg: 870,
        mealType: 'Scan',
        barcode: '013800100125',
        loggedAt: withTime(daysAgo(1), 19, 20),
      },
      {
        id: 'food-6',
        foodName: 'Pretzels',
        servingSize: '1 serving',
        sodiumMg: 340,
        mealType: 'Snack',
        barcode: '',
        loggedAt: withTime(daysAgo(2), 14, 5),
      },
      {
        id: 'food-7',
        foodName: 'Grilled chicken salad',
        servingSize: '1 bowl',
        sodiumMg: 410,
        mealType: 'Meal',
        barcode: '',
        loggedAt: withTime(daysAgo(3), 13, 0),
      },
      {
        id: 'food-8',
        foodName: 'Instant noodles',
        servingSize: '1 pack',
        sodiumMg: 1460,
        mealType: 'Scan',
        barcode: '070662030057',
        loggedAt: withTime(daysAgo(4), 20, 15),
      },
      {
        id: 'food-9',
        foodName: 'Scrambled eggs',
        servingSize: '2 eggs',
        sodiumMg: 140,
        mealType: 'Meal',
        barcode: '',
        loggedAt: withTime(daysAgo(5), 8, 25),
      },
      {
        id: 'food-10',
        foodName: 'Low sodium crackers',
        servingSize: '5 crackers',
        sodiumMg: 120,
        mealType: 'Snack',
        barcode: '',
        loggedAt: withTime(daysAgo(6), 16, 50),
      },
    ],
    medicationLogs: [
      {
        id: 'med-1',
        medicationName: 'Lisinopril',
        dosage: '10 mg',
        takenAt: withTime(daysAgo(0), 8, 0),
        notes: 'Morning dose',
      },
    ],
    reminders: [
      {
        id: 'reminder-1',
        title: 'Take blood pressure medicine',
        reminderType: 'medication',
        timeOfDay: '08:00',
        enabled: true,
        medicationName: 'Lisinopril',
        notes: 'Morning reminder',
      },
    ],
    goalBadges: [],
  }
}

module.exports = {
  createSeedData,
}
