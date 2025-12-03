const getPlan = async (planId) => { 
    const planResponse = await fetch(
    `https://api.whop.com/api/v1/plans/${planId}`,
    {
      headers: {
        Authorization: `Bearer ${"apik_NOGJc7RtuuHWl_A2017686_3q2zZAOPHwOzoTpmbWrTJt4-oD3zGbJq9b-qxH6W5Y8" || ''}`,
      },
    }
  );
  if (planResponse.ok) {
    const planData = await planResponse.json();
    return planData;
  }
  return null;
}

const planId = 'plan_uqeQj3xUcBtVs';
const plan = await getPlan(planId);
console.log(JSON.stringify(plan, null, 2));