import express from "express";
import dotenv from "dotenv";
import { createClient } from "@base44/sdk";

dotenv.config();

const app = express();
app.use(express.json());

const base44 = createClient({
  appId: process.env.BASE44_APP_ID,
  headers: {
    api_key: process.env.BASE44_API_KEY
  }
});

app.get("/", (req, res) => {
  res.send("Semper Fi Base44 Webhook Running");
});

app.post("/create-project", async (req, res) => {
  try {
    const { client, project, tasks } = req.body;

    if (!client?.name || !project?.name || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: client.name, project.name, and at least one task"
      });
    }

    const createdClient = await base44.entities.Client.create({
      name: client.name,
      primary_contact_email: client.email || "",
      website: client.website || "",
      notes_internal: client.notes_internal || "",
      status: "active"
    });

    const createdProject = await base44.entities.Project.create({
      client_id: createdClient.id,
      name: project.name,
      type: project.type || "other",
      status: project.status || "intake",
      description: project.description || "",
      due_date: project.due_date || "",
      client_summary_visible: project.client_summary_visible || "",
      internal_notes: project.internal_notes || ""
    });

    const createdTasks = await base44.entities.Task.bulkCreate(
      tasks.map(task => ({
        client_id: createdClient.id,
        project_id: createdProject.id,
        title: task.title,
        description: task.description || "",
        priority: task.priority || "med",
        status: task.status || "not_started",
        assigned_to_name: task.assigned_to_name || "",
        due_date: task.due_date || "",
        visibility: task.visibility || "internal_only"
      }))
    );

    return res.json({
      success: true,
      client_id: createdClient.id,
      project_id: createdProject.id,
      task_count: createdTasks.length,
      message: "Project and tasks created successfully"
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
