import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const BASE44_BASE_URL = "https://semper-fi-flow.base44.app/api";

async function base44Request(path, method, body) {
  const response = await fetch(`${BASE44_BASE_URL}${path}`, {
    method,
   headers: {
  "Content-Type": "application/json",
  "api_key": process.env.BASE44_API_KEY,
  "X-Base44-App-Id": process.env.BASE44_APP_ID
},
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

app.get("/", (req, res) => {
  res.send("Semper Fi Base44 Webhook Running");
});

app.post("/create-project", async (req, res) => {
  try {
    const { client, project, tasks } = req.body;

    const createdClient = await base44Request("/entities/Client", "POST", {
      name: client.name,
      primary_contact_email: client.email || "",
      website: client.website || "",
      status: "active"
    });

    const createdProject = await base44Request("/entities/Project", "POST", {
      client_id: createdClient.id,
      name: project.name,
      type: project.type || "other",
      status: "intake",
      description: project.description || "",
      due_date: project.due_date || ""
    });

    const createdTasks = await base44Request("/entities/Task/bulk", "POST",
      tasks.map(task => ({
        client_id: createdClient.id,
        project_id: createdProject.id,
        title: task.title,
        description: task.description || "",
        priority: task.priority || "med",
        status: "not_started",
        due_date: task.due_date || "",
        visibility: "internal_only"
      }))
    );

    res.json({
      success: true,
      client_id: createdClient.id,
      project_id: createdProject.id,
      task_count: createdTasks.length
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
