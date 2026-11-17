import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const BACKDROP_CLASS = "fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0";

const VIEWPORT_CLASS = "fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center p-4";

const POPUP_CLASS =
  "w-110 max-w-full rounded-2xl bg-popover text-foreground shadow-dialog outline-none transition duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:translate-y-1.5 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:translate-y-1.5 data-starting-style:scale-98 data-starting-style:opacity-0 motion-reduce:transition-none";

const stopKeys = (e: React.KeyboardEvent) => e.stopPropagation();

const Dialog = DialogPrimitive.Root;

function DialogPopup({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className={BACKDROP_CLASS} data-slot="dialog-backdrop" />
      <DialogPrimitive.Viewport className={VIEWPORT_CLASS}>
        <DialogPrimitive.Popup className={cn(POPUP_CLASS, className)} data-slot="dialog-popup" onKeyDown={stopKeys} {...props}>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title className={cn("m-0 text-lg leading-tight font-heading tracking-title", className)} data-slot="dialog-title" {...props} />;
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("-mt-1.5 text-sm leading-normal text-secondary-foreground", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 px-5.5 pt-5.5 pb-4.5", className)} data-slot="dialog-body" {...props} />;
}

function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-0.5 flex justify-end gap-2", className)} data-slot="dialog-footer" {...props} />;
}

function DialogError({ className, ...props }: ComponentProps<"p">) {
  return <p role="alert" className={cn("-mt-1 text-small text-destructive-foreground", className)} data-slot="dialog-error" {...props} />;
}

const AlertDialog = AlertDialogPrimitive.Root;

function AlertDialogPopup({ className, children, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className={BACKDROP_CLASS} data-slot="alert-dialog-backdrop" />
      <AlertDialogPrimitive.Viewport className={VIEWPORT_CLASS}>
        <AlertDialogPrimitive.Popup className={cn(POPUP_CLASS, className)} data-slot="alert-dialog-popup" onKeyDown={stopKeys} {...props}>
          {children}
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Viewport>
    </AlertDialogPrimitive.Portal>
  );
}

const DialogClose = DialogPrimitive.Close;
const AlertDialogClose = AlertDialogPrimitive.Close;

export {
  AlertDialog,
  AlertDialogClose,
  AlertDialogPopup,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogPopup,
  DialogTitle,
};
